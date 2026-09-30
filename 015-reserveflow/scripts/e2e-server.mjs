// Starts a fresh production server for E2E: resets the E2E database schema first.
import pg from 'pg';
const url = process.env.DATABASE_URL;
if (!/e2e/.test(url)) throw new Error('refusing to reset a non-e2e database');
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await c.end();
await import('../dist-server/server/index.js');
