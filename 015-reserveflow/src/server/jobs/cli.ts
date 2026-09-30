import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { createMailer } from '../services/notifications.js';
import { runJobsOnce } from './worker.js';

// One-shot job run for external schedulers (cron). Safe to run while the web process' worker is also running.
const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl, 2);
runJobsOnce(pool, cfg, createMailer(cfg), (m) => console.log(m))
  .then(() => console.log('jobs done'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
