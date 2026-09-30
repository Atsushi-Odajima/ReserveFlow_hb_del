import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  // works both from src (tsx) and dist-server (compiled; sql copied by build step)
  const candidates = [join(here, 'migrations'), join(here, '../../../src/server/db/migrations')];
  for (const c of candidates) {
    try {
      if (readdirSync(c).some((f) => f.endsWith('.sql'))) return c;
    } catch {
      /* next */
    }
  }
  throw new Error('migrations directory not found');
}

export async function migrate(pool: pg.Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('rf:migrate'))`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('rf:migrate'))`).catch(() => {});
    client.release();
  }
  return applied;
}
