import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl, 1);
migrate(pool, (m) => console.log(m))
  .then((a) => console.log(a.length ? `migrations applied: ${a.length}` : 'schema up to date'))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
