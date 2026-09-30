import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { seedSample } from './sample.js';

// Creates the fictional "Sample Studio" (flagged as sample: e-mails are never sent for it).
const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl, 4);
const email = process.env.SAMPLE_OWNER_EMAIL ?? 'owner@sample.invalid';
const password = process.env.SAMPLE_OWNER_PASSWORD ?? 'sample-password-123';
try {
  await migrate(pool);
  const exists = (await pool.query(`SELECT 1 FROM businesses WHERE slug = 'sample-studio'`)).rows[0];
  if (exists) {
    console.log('sample-studio already exists (skip)');
  } else {
    const r = await seedSample(pool, { ownerEmail: email, ownerPassword: password, staffEmail: 'aki@sample.invalid', staffPassword: 'sample-password-123' });
    console.log(`Sample Studio created: /book/${r.slug}`);
    console.log(`owner login: ${email} / ${password}`);
    console.log('staff login: aki@sample.invalid / sample-password-123');
  }
} finally {
  await pool.end();
}
