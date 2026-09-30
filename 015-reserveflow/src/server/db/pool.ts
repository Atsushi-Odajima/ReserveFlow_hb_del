import pg from 'pg';

// timestamptz -> JS Date (default), date (1082) -> keep 'YYYY-MM-DD' string (no TZ shift)
pg.types.setTypeParser(1082, (v: string) => v);
// int8 -> number (counts; safe for our ranges)
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string, max = 10): pg.Pool {
  const ssl = /sslmode=(require|verify-full|verify-ca)/.test(databaseUrl) ? { rejectUnauthorized: !/sslmode=require/.test(databaseUrl) } : undefined;
  return new pg.Pool({ connectionString: databaseUrl, max, ssl, application_name: 'reserveflow' });
}

export async function withTx<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Serialize all availability-changing writes of one business. Released automatically at COMMIT/ROLLBACK. */
export async function lockBusiness(tx: pg.PoolClient, businessId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('rf:biz:' || $1::text))`, [businessId]);
}
