import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { APP_VERSION, type Config } from './config.js';
import { sendError, type AppDeps } from './http.js';
import type { Mailer } from './services/notifications.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerAdminSetupRoutes } from './routes/admin-setup.js';
import { registerAdminBookingRoutes } from './routes/admin-bookings.js';
import { registerAdminDataRoutes } from './routes/admin-data.js';

const here = dirname(fileURLToPath(import.meta.url));

function webRoot(): string | null {
  for (const p of [join(here, '../../dist-web'), join(here, '../../../dist-web')]) if (existsSync(join(p, 'index.html'))) return p;
  return null;
}

export async function buildApp(cfg: Config, pool: pg.Pool, mailer: Mailer, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers["x-manage-token"]'] } : false,
    trustProxy: cfg.trustProxy,
    bodyLimit: 6 * 1024 * 1024,
  });
  const deps: AppDeps = { pool, cfg, mailer };

  await app.register(cookie);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', req.url.startsWith('/manage') || req.url.startsWith('/invite') ? 'no-referrer' : 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    const turnstile = cfg.turnstileSiteKey ? ' https://challenges.cloudflare.com' : '';
    reply.header(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'${turnstile}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src${turnstile || " 'none'"}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
    );
    if (cfg.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => sendError(reply, err, (o, m) => req.log.error(o, m)));

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, version: APP_VERSION };
  });

  registerAuthRoutes(app, deps);
  registerPublicRoutes(app, deps);
  registerAdminSetupRoutes(app, deps);
  registerAdminBookingRoutes(app, deps);
  registerAdminDataRoutes(app, deps);

  const root = webRoot();
  if (root) {
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      wildcard: false,
      setHeaders: (res, path) => {
        if (/[\\/]assets[\\/]/.test(path)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
        if (path.endsWith('sw.js')) res.header('Service-Worker-Allowed', '/');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') || path.startsWith('/assets/') || /\.[a-z0-9]{2,5}$/i.test(path) || !root || req.method !== 'GET') {
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: '見つかりません', details: null } });
      return;
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  });

  return app;
}
