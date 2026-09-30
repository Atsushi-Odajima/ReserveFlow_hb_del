import type pg from 'pg';
import type { Config } from '../config.js';
import { runNotificationsOnce, type Mailer } from '../services/notifications.js';
import { extendAllRules } from '../services/recurrence.js';
import { expireWaitlist } from '../services/waitlist.js';

export async function runJobsOnce(pool: pg.Pool, cfg: Config, mailer: Mailer, log: (m: string) => void = () => {}): Promise<void> {
  const n = await runNotificationsOnce(pool, cfg, mailer);
  if (n.claimed || n.staleMarkedUnknown) log(`notifications: claimed=${n.claimed} sent=${n.sent} failed=${n.failed} skipped=${n.skipped} unknown=${n.staleMarkedUnknown}`);
  const created = await extendAllRules(pool);
  if (created) log(`recurrence: created ${created} occurrences`);
  await expireWaitlist(pool);
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await pool.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`);
}

/** In-process scheduler (one per instance; overlapping runs are prevented and DB claiming makes multi-instance safe). */
export function startWorker(pool: pg.Pool, cfg: Config, mailer: Mailer, log: (m: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runJobsOnce(pool, cfg, mailer, log);
    } catch (e) {
      log(`worker error: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, cfg.workerIntervalMs);
  setTimeout(tick, 3000);
  return () => clearInterval(t);
}
