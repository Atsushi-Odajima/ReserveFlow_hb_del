import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../db/pool.js';
import { isValidTimezone } from '../engine/time.js';
import { hashPassword, sha256Hex, verifyPassword } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden } from '../lib/errors.js';
import { normEmail } from '../lib/normalize.js';
import { audit } from '../services/audit.js';
import { createSession, loadAuth, parse, rateLimit, clientIp, requireMember, SESSION_COOKIE, type AppDeps } from '../http.js';

const zPassword = z.string().min(10, 'パスワードは10文字以上にしてください').max(200);
export const zSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'URL名は半角英小文字・数字・ハイフンで3〜40文字にしてください');
const RESERVED_SLUGS = new Set(['app', 'api', 'admin', 'book', 'manage', 'login', 'signup', 'invite', 'assets', 'static', 'www']);

export async function createBusinessWithOwner(
  deps: AppDeps,
  i: { email: string; password: string; name: string; businessName: string; slug: string; timezone: string; isSample?: boolean },
): Promise<{ userId: string; businessId: string }> {
  if (RESERVED_SLUGS.has(i.slug)) throw badRequest('このURL名は使用できません');
  if (!isValidTimezone(i.timezone)) throw badRequest('タイムゾーンが正しくありません');
  const hash = await hashPassword(i.password);
  return withTx(deps.pool, async (tx) => {
    const exists = await tx.query(`SELECT 1 FROM businesses WHERE slug = $1`, [i.slug]);
    if (exists.rows[0]) throw conflict('SLUG_TAKEN', 'このURL名はすでに使われています');
    const em = normEmail(i.email)!;
    let userId: string;
    const u = await tx.query(`SELECT id FROM users WHERE email_normalized = $1`, [em]);
    if (u.rows[0]) throw conflict('EMAIL_TAKEN', 'このメールアドレスはすでに登録されています。ログインしてください。');
    const ins = await tx.query(`INSERT INTO users (email, email_normalized, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [i.email.trim(), em, i.name.trim(), hash]);
    userId = ins.rows[0].id;
    const b = await tx.query(
      `INSERT INTO businesses (slug, name, timezone, email, is_sample) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [i.slug, i.businessName.trim(), i.timezone, i.email.trim(), i.isSample ?? false],
    );
    const businessId = b.rows[0].id;
    await tx.query(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1,$2,'owner')`, [userId, businessId]);
    // default hours: Mon-Sat 10:00-18:00
    for (const wd of [1, 2, 3, 4, 5, 6])
      await tx.query(`INSERT INTO weekly_hours (business_id, owner_kind, owner_id, weekday, start_min, end_min) VALUES ($1,'business',$1,$2,600,1080)`, [businessId, wd]);
    await audit(tx, businessId, { type: 'user', userId }, 'business.create', 'business', businessId, { slug: i.slug });
    return { userId, businessId };
  });
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get('/api/auth/config', async () => ({ allowSignup: deps.cfg.allowSignup }));

  app.post('/api/auth/signup', async (req, reply) => {
    if (!deps.cfg.allowSignup) throw forbidden('新規登録は無効になっています（管理者にお問い合わせください）');
    await rateLimit(deps, `signup:${clientIp(req)}`, 10, 3600);
    const body = parse(
      z.object({
        email: z.string().email('メールアドレスの形式が正しくありません').max(200),
        password: zPassword,
        name: z.string().trim().min(1, '氏名を入力してください').max(100),
        businessName: z.string().trim().min(1, '事業者名を入力してください').max(100),
        slug: zSlug,
        timezone: z.string().max(64),
      }),
      req.body,
    );
    const { userId, businessId } = await createBusinessWithOwner(deps, body);
    const csrf = await createSession(deps, reply, userId, businessId);
    return { ok: true, csrfToken: csrf };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string().max(200), password: z.string().max(200) }), req.body);
    const em = normEmail(body.email) ?? '';
    await rateLimit(deps, `login-ip:${clientIp(req)}`, 30, 900);
    await rateLimit(deps, `login-user:${em}`, 10, 900);
    const u = (await deps.pool.query(`SELECT id, password_hash, locked_until, disabled_at FROM users WHERE email_normalized = $1`, [em])).rows[0];
    const fail = () => new AppError(401, 'INVALID_LOGIN', 'メールアドレスまたはパスワードが正しくありません');
    if (!u) {
      await verifyPassword(body.password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      throw fail();
    }
    if (u.disabled_at) throw fail();
    if (u.locked_until && u.locked_until > new Date()) throw new AppError(429, 'LOCKED', 'ログイン失敗が続いたため一時的にロックしています。15分後にお試しください。');
    if (!(await verifyPassword(body.password, u.password_hash))) {
      await deps.pool.query(
        `UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 8 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`,
        [u.id],
      );
      throw fail();
    }
    await deps.pool.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [u.id]);
    const m = (await deps.pool.query(`SELECT business_id FROM memberships WHERE user_id = $1 ORDER BY role = 'owner' DESC, created_at LIMIT 1`, [u.id])).rows[0];
    const csrf = await createSession(deps, reply, u.id, m?.business_id ?? null);
    await audit(deps.pool, m?.business_id ?? null, { type: 'user', userId: u.id }, 'auth.login', 'user', u.id, {});
    return { ok: true, csrfToken: csrf };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await deps.pool.query(`DELETE FROM sessions WHERE id = $1`, [sha256Hex(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const a = await loadAuth(deps, req);
    if (!a) return { user: null };
    const businesses = (
      await deps.pool.query(`SELECT b.id, b.name, b.slug, m.role FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 ORDER BY b.name`, [a.userId])
    ).rows;
    const biz = a.businessId
      ? (await deps.pool.query(`SELECT id, name, brand_name, slug, timezone, theme_color, published, is_sample, week_start FROM businesses WHERE id = $1`, [a.businessId])).rows[0]
      : null;
    return {
      user: { id: a.userId, name: a.userName, email: a.email },
      csrfToken: a.csrfToken,
      role: a.role,
      staffId: a.staffId,
      permissions: a.perms,
      business: biz,
      businesses,
    };
  });

  app.post('/api/auth/switch-business', async (req) => {
    const a = await loadAuth(deps, req);
    if (!a) throw new AppError(401, 'UNAUTHENTICATED', 'ログインしてください');
    const h = req.headers['x-csrf-token'];
    if (h !== a.csrfToken) throw new AppError(403, 'CSRF', '画面を再読み込みしてからやり直してください');
    const { businessId } = parse(z.object({ businessId: z.string().uuid() }), req.body);
    const m = await deps.pool.query(`SELECT 1 FROM memberships WHERE user_id = $1 AND business_id = $2`, [a.userId, businessId]);
    if (!m.rows[0]) throw forbidden();
    await deps.pool.query(`UPDATE sessions SET business_id = $2 WHERE id = $1`, [a.sessionId, businessId]);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const a = await requireMember(deps, req);
    const body = parse(z.object({ current: z.string().max(200), next: zPassword }), req.body);
    const u = (await deps.pool.query(`SELECT password_hash FROM users WHERE id = $1`, [a.userId])).rows[0];
    if (!(await verifyPassword(body.current, u.password_hash))) throw badRequest('現在のパスワードが正しくありません');
    await deps.pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [a.userId, await hashPassword(body.next)]);
    await deps.pool.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [a.userId, a.sessionId]);
    await audit(deps.pool, a.businessId, a.actor, 'auth.password_change', 'user', a.userId, {});
    return { ok: true };
  });

  app.post('/api/auth/invite/info', async (req) => {
    await rateLimit(deps, `invite:${clientIp(req)}`, 30, 900);
    const { token } = parse(z.object({ token: z.string().max(100) }), req.body);
    const inv = (
      await deps.pool.query(
        `SELECT i.email, i.role, b.name AS business_name FROM invites i JOIN businesses b ON b.id = i.business_id WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()`,
        [sha256Hex(token)],
      )
    ).rows[0];
    if (!inv) throw badRequest('招待リンクが無効か期限切れです。オーナーに再発行を依頼してください。');
    const existing = (await deps.pool.query(`SELECT 1 FROM users WHERE email_normalized = $1`, [normEmail(inv.email)])).rows[0];
    return { email: inv.email, role: inv.role, businessName: inv.business_name, existingUser: !!existing };
  });

  app.post('/api/auth/invite/accept', async (req, reply) => {
    await rateLimit(deps, `invite:${clientIp(req)}`, 30, 900);
    const body = parse(z.object({ token: z.string().max(100), name: z.string().trim().min(1).max(100), password: z.string().max(200) }), req.body);
    const result = await withTx(deps.pool, async (tx) => {
      const inv = (await tx.query(`SELECT * FROM invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256Hex(body.token)])).rows[0];
      if (!inv) throw badRequest('招待リンクが無効か期限切れです。オーナーに再発行を依頼してください。');
      const em = normEmail(inv.email)!;
      let user = (await tx.query(`SELECT id, password_hash FROM users WHERE email_normalized = $1`, [em])).rows[0];
      if (user) {
        if (!(await verifyPassword(body.password, user.password_hash))) throw badRequest('既存アカウントのパスワードが正しくありません');
      } else {
        parse(zPassword, body.password);
        user = (await tx.query(`INSERT INTO users (email, email_normalized, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id`, [inv.email, em, body.name, await hashPassword(body.password)])).rows[0];
      }
      await tx.query(
        `INSERT INTO memberships (user_id, business_id, role, staff_id, permissions) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, business_id) DO UPDATE SET role = EXCLUDED.role, staff_id = EXCLUDED.staff_id, permissions = EXCLUDED.permissions`,
        [user.id, inv.business_id, inv.role, inv.staff_id, inv.permissions],
      );
      await tx.query(`UPDATE invites SET used_at = now() WHERE id = $1`, [inv.id]);
      await audit(tx, inv.business_id, { type: 'user', userId: user.id }, 'member.join', 'user', user.id, { role: inv.role });
      return { userId: user.id as string, businessId: inv.business_id as string };
    });
    const csrf = await createSession(deps, reply, result.userId, result.businessId);
    return { ok: true, csrfToken: csrf };
  });
}
