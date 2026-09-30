import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z, type ZodType } from 'zod';
import type { Config } from './config.js';
import { randomToken, safeEqual, sha256Hex } from './lib/crypto.js';
import { AppError, badRequest, forbidden } from './lib/errors.js';
import type { Actor } from './services/audit.js';
import type { Mailer } from './services/notifications.js';

export interface AppDeps {
  pool: pg.Pool;
  cfg: Config;
  mailer: Mailer;
}

export const SESSION_COOKIE = 'rf_session';
const SESSION_DAYS = 14;

export interface StaffPermissions {
  viewAllBookings: boolean;
  manageBookings: boolean;
  viewCustomers: boolean;
  manageOwnBlocks: boolean;
}

export const DEFAULT_STAFF_PERMISSIONS: StaffPermissions = {
  viewAllBookings: false,
  manageBookings: true,
  viewCustomers: true,
  manageOwnBlocks: true,
};

export interface AuthContext {
  userId: string;
  userName: string;
  email: string;
  sessionId: string;
  csrfToken: string;
  businessId: string | null;
  role: 'owner' | 'staff' | null;
  staffId: string | null;
  perms: StaffPermissions;
  actor: Actor;
}

export interface Scoped extends AuthContext {
  businessId: string;
  role: 'owner' | 'staff';
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of r.error.issues) fieldErrors[issue.path.join('.') || '_'] = issue.message;
    throw badRequest('入力内容を確認してください', { fieldErrors });
  }
  return r.data;
}

export const zUuid = z.string().uuid();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日付の形式が正しくありません');
export const zIso = z.string().datetime({ offset: true });

export async function createSession(deps: AppDeps, reply: FastifyReply, userId: string, businessId: string | null): Promise<string> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await deps.pool.query(`INSERT INTO sessions (id, user_id, business_id, csrf_token, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${SESSION_DAYS} days')`, [
    sha256Hex(token),
    userId,
    businessId,
    csrf,
  ]);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.cfg.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
  return csrf;
}

export async function loadAuth(deps: AppDeps, req: FastifyRequest): Promise<AuthContext | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 100) return null;
  const r = await deps.pool.query(
    `SELECT s.id AS sid, s.csrf_token, s.business_id, u.id AS uid, u.name, u.email, m.role, m.staff_id, m.permissions
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = u.id AND m.business_id = s.business_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256Hex(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  deps.pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'`, [row.sid]).catch(() => {});
  const role = row.role as 'owner' | 'staff' | null;
  const perms: StaffPermissions =
    role === 'owner'
      ? { viewAllBookings: true, manageBookings: true, viewCustomers: true, manageOwnBlocks: true }
      : { ...DEFAULT_STAFF_PERMISSIONS, ...(row.permissions ?? {}) };
  return {
    userId: row.uid,
    userName: row.name,
    email: row.email,
    sessionId: row.sid,
    csrfToken: row.csrf_token,
    businessId: role ? row.business_id : null,
    role,
    staffId: row.staff_id,
    perms,
    actor: { type: 'user', userId: row.uid },
  };
}

/** Require a logged-in member of a business. Non-GET requests must carry the CSRF token header. */
export async function requireMember(deps: AppDeps, req: FastifyRequest): Promise<Scoped> {
  const a = await loadAuth(deps, req);
  if (!a) throw new AppError(401, 'UNAUTHENTICATED', 'ログインしてください');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const h = req.headers['x-csrf-token'];
    if (typeof h !== 'string' || !safeEqual(h, a.csrfToken)) throw new AppError(403, 'CSRF', '画面を再読み込みしてからやり直してください');
  }
  if (!a.businessId || !a.role) throw new AppError(403, 'NO_BUSINESS', '事業者が選択されていません');
  return a as Scoped;
}

export async function requireOwner(deps: AppDeps, req: FastifyRequest): Promise<Scoped> {
  const a = await requireMember(deps, req);
  if (a.role !== 'owner') throw forbidden('オーナーのみ操作できます');
  return a;
}

export function clientIp(req: FastifyRequest): string {
  return req.ip || 'unknown';
}

/**
 * Fixed-window rate limit stored in PostgreSQL (works across restarts and multiple instances).
 * Keys are hashed so no raw IP / e-mail is stored.
 */
export async function rateLimit(deps: AppDeps, key: string, limit: number, windowSec: number): Promise<void> {
  const k = sha256Hex(`${deps.cfg.appSecret}:${key}`);
  const r = await deps.pool.query(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [k, windowSec],
  );
  if (r.rows[0].count > limit * (deps.cfg.rateLimitScale ?? 1)) throw new AppError(429, 'RATE_LIMITED', 'アクセスが集中しています。しばらく待ってから再度お試しください。');
}

export function sendError(reply: FastifyReply, e: unknown, log: (o: unknown, m: string) => void): void {
  if (e instanceof AppError) {
    reply.status(e.status).send({ error: { code: e.code, message: e.message, details: e.details ?? null } });
    return;
  }
  const err = e as { statusCode?: number; code?: string; message?: string; validation?: unknown };
  if (err.statusCode && err.statusCode < 500) {
    reply.status(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: 'リクエストが正しくありません', details: null } });
    return;
  }
  log(e, 'unhandled error');
  reply.status(500).send({ error: { code: 'INTERNAL', message: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。', details: null } });
}
