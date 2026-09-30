import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) throw new Error(`環境変数 ${name} が設定されていません`);
    return fallback;
  }
  return v;
}

const here = dirname(fileURLToPath(import.meta.url));

function readAppVersion(): string {
  for (const p of [join(here, '../../package.json'), join(here, '../../../package.json')]) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')).version as string;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

export const APP_VERSION = readAppVersion();
export const SCHEMA_VERSION = 1;

export interface Config {
  nodeEnv: string;
  port: number;
  host: string;
  databaseUrl: string;
  appSecret: string;
  publicBaseUrl: string;
  allowSignup: boolean;
  emailDriver: 'log' | 'smtp';
  smtpUrl: string;
  emailFrom: string;
  runWorker: boolean;
  workerIntervalMs: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  turnstileSecret: string;
  turnstileSiteKey: string;
  /** multiplies every rate limit (automated E2E/load tests only; keep 1 in production) */
  rateLimitScale: number;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = env('NODE_ENV', 'development');
  const prod = nodeEnv === 'production';
  const appSecret = env('APP_SECRET', prod ? undefined : 'dev-only-secret-change-me-dev-only-secret');
  if (prod && appSecret.length < 32) throw new Error('APP_SECRET は32文字以上にしてください');
  const cfg: Config = {
    nodeEnv,
    port: Number(env('PORT', '8787')),
    host: env('HOST', prod ? '0.0.0.0' : '127.0.0.1'),
    databaseUrl: env('DATABASE_URL', prod ? undefined : 'postgres://reserveflow:reserveflow@127.0.0.1:5432/reserveflow_dev'),
    appSecret,
    publicBaseUrl: env('PUBLIC_BASE_URL', 'http://127.0.0.1:8787').replace(/\/$/, ''),
    allowSignup: env('ALLOW_SIGNUP', prod ? 'false' : 'true') === 'true',
    emailDriver: env('EMAIL_DRIVER', 'log') === 'smtp' ? 'smtp' : 'log',
    smtpUrl: env('SMTP_URL', ''),
    emailFrom: env('EMAIL_FROM', 'ReserveFlow <no-reply@example.invalid>'),
    runWorker: env('RUN_WORKER', 'true') === 'true',
    workerIntervalMs: Number(env('WORKER_INTERVAL_MS', '60000')),
    cookieSecure: env('COOKIE_SECURE', prod ? 'true' : 'false') === 'true',
    trustProxy: env('TRUST_PROXY', prod ? 'true' : 'false') === 'true',
    turnstileSecret: env('TURNSTILE_SECRET_KEY', ''),
    turnstileSiteKey: env('TURNSTILE_SITE_KEY', ''),
    rateLimitScale: Math.max(1, Number(env('RATE_LIMIT_SCALE', '1'))),
    ...overrides,
  };
  return cfg;
}
