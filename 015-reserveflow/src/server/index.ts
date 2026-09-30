import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';
import { createMailer } from './services/notifications.js';
import { startWorker } from './jobs/worker.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl, Number(process.env.DB_POOL_MAX ?? 10));
await migrate(pool, (m) => console.log(`[migrate] ${m}`));
const mailer = createMailer(cfg);
const app = await buildApp(cfg, pool, mailer, { logger: true });
const stop = cfg.runWorker ? startWorker(pool, cfg, mailer, (m) => app.log.info(m)) : () => {};
await app.listen({ port: cfg.port, host: cfg.host });

const shutdown = async () => {
  stop();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
