import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from '../../src/server/app.js';
import { loadConfig, type Config } from '../../src/server/config.js';
import { createPool } from '../../src/server/db/pool.js';
import { migrate } from '../../src/server/db/migrate.js';
import { LogMailer } from '../../src/server/services/notifications.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://reserveflow:reserveflow@127.0.0.1:5432/reserveflow_test';

export interface TestEnv {
  app: FastifyInstance;
  pool: pg.Pool;
  cfg: Config;
  mailer: LogMailer;
  close: () => Promise<void>;
}

export async function resetDb(url = TEST_DB): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

export async function setup(opts: { reset?: boolean; poolMax?: number } = {}): Promise<TestEnv> {
  process.env.NODE_ENV = 'test';
  if (opts.reset !== false) await resetDb();
  const cfg = loadConfig({ nodeEnv: 'test', databaseUrl: TEST_DB, allowSignup: true, publicBaseUrl: 'http://test.local', runWorker: false });
  const pool = createPool(TEST_DB, opts.poolMax ?? 20);
  await migrate(pool);
  const mailer = new LogMailer(false);
  const app = await buildApp(cfg, pool, mailer);
  await app.ready();
  return {
    app,
    pool,
    cfg,
    mailer,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** A logged-in admin client that keeps its cookie + CSRF token. */
export class Client {
  cookie = '';
  csrf = '';
  ip: string;
  constructor(private app: FastifyInstance, ip?: string) {
    this.ip = ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  }

  async req(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.app.inject({
      method,
      url,
      remoteAddress: this.ip,
      payload: body === undefined ? undefined : (body as object),
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf && method !== 'GET' ? { 'x-csrf-token': this.csrf } : {}), ...headers },
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const s = Array.isArray(set) ? set : [set];
      for (const c of s) if (c.startsWith('rf_session=')) this.cookie = c.split(';')[0];
    }
    const j = safeJson(res.body);
    if (j && typeof j === 'object' && 'csrfToken' in j && typeof j.csrfToken === 'string') this.csrf = j.csrfToken;
    return res;
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
  put = (url: string, body: unknown = {}) => this.req('PUT', url, body);
  del = (url: string) => this.req('DELETE', url);

  async json<T = any>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, expect = 200): Promise<T> {
    const r = await this.req(method, url, body);
    if (r.statusCode !== expect) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return JSON.parse(r.body) as T;
  }

  async login(email: string, password: string) {
    const r = await this.req('POST', '/api/auth/login', { email, password });
    if (r.statusCode !== 200) throw new Error(`login failed ${r.body}`);
    const me = await this.json('GET', '/api/auth/me');
    this.csrf = me.csrfToken;
    return me;
  }
}

export function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

let seq = 0;
export async function signupOwner(app: FastifyInstance, o: { slug?: string; timezone?: string } = {}) {
  const c = new Client(app);
  const n = ++seq;
  const slug = o.slug ?? `biz-${Date.now().toString(36)}-${n}`;
  const email = `owner${n}-${slug}@example.test`;
  await c.json('POST', '/api/auth/signup', { email, password: 'correct-horse-battery', name: `Owner ${n}`, businessName: `Biz ${n}`, slug, timezone: o.timezone ?? 'Asia/Tokyo' });
  const me = await c.json('GET', '/api/auth/me');
  c.csrf = me.csrfToken;
  return { client: c, email, slug, businessId: me.business.id as string };
}

/** All-week 10:00-18:00 hours + one 60 min service + one staff, published. */
export async function basicSetup(c: Client, o: { durationMin?: number; bufferBeforeMin?: number; bufferAfterMin?: number; capacity?: number; maxPartySize?: number; minNoticeMin?: number; resource?: boolean; staffCount?: number; bookingMode?: 'slots' | 'sessions' } = {}) {
  const settings = await c.json('GET', '/api/admin/settings');
  await c.json('PUT', '/api/admin/settings', { ...settings, published: true, minNoticeMin: o.minNoticeMin ?? 0, maxAdvanceDays: 60, slotIntervalMin: 30, email: 'owner-shop@example.test' });
  await c.json('PUT', '/api/admin/hours', { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 600, endMin: 1080 })) });
  let resourceId: string | undefined;
  if (o.resource) resourceId = (await c.json('POST', '/api/admin/resources', { name: 'Room A', quantity: 1 })).id;
  const service = await c.json('POST', '/api/admin/services', {
    name: '60分レッスン',
    durationMin: o.durationMin ?? 60,
    bufferBeforeMin: o.bufferBeforeMin ?? 0,
    bufferAfterMin: o.bufferAfterMin ?? 0,
    capacity: o.capacity ?? 1,
    maxPartySize: o.maxPartySize ?? 1,
    bookingMode: o.bookingMode ?? 'slots',
    resourceIds: resourceId ? [resourceId] : [],
  });
  const staffIds: string[] = [];
  for (let i = 0; i < (o.staffCount ?? 1); i++) staffIds.push((await c.json('POST', '/api/admin/staff', { displayName: `Staff${i + 1}`, serviceIds: [service.id], sortOrder: i })).id);
  return { serviceId: service.id as string, staffIds, resourceId };
}

/** Local date string N days from now in Tokyo. */
export function futureDate(days: number, tz = 'Asia/Tokyo'): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toLocaleDateString('sv-SE', { timeZone: tz });
}

export function isoAt(date: string, hh: number, mm = 0, offset = '+09:00'): string {
  return new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00${offset}`).toISOString();
}

export function publicBooking(app: FastifyInstance, slug: string, body: Record<string, unknown>, ip = `172.16.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`) {
  return app.inject({ method: 'POST', url: `/api/public/${slug}/bookings`, payload: { elapsedMs: 10_000, answers: [], ...body }, remoteAddress: ip });
}

export type { Config };
