/**
 * Load-test dataset (target volumes from the spec):
 *   services 100, staff 50, resources 100, customers 50,000, bookings 200,000, notifications 500,000.
 * Bookings are generated consistently (no overlapping staff occupancy, allocations present) so the
 * exclusion constraint and the engine operate on realistic data.
 * Usage: LOAD_DATABASE_URL=... npx tsx tests/load/seed-load.ts
 */
import pg from 'pg';
import { createPool } from '../../src/server/db/pool.js';
import { migrate } from '../../src/server/db/migrate.js';
import { hashPassword } from '../../src/server/lib/crypto.js';

const url = process.env.LOAD_DATABASE_URL ?? 'postgres://reserveflow:reserveflow@127.0.0.1:5432/reserveflow_load';
if (!/load/.test(url)) throw new Error('refusing to seed a non-load database');
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await c.end();
const pool = createPool(url, 4);
await migrate(pool);
const t0 = Date.now();
const q = (sql: string, args: unknown[] = []) => pool.query(sql, args);
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const owner = (await q(`INSERT INTO users (email, email_normalized, name, password_hash) VALUES ('load@example.test','load@example.test','Load Owner',$1) RETURNING id`, [await hashPassword('load-password-123')])).rows[0].id;
const B = (await q(`INSERT INTO businesses (slug, name, timezone, published, min_notice_min, max_advance_days, slot_interval_min) VALUES ('load-shop','Load Shop','Asia/Tokyo',true,0,120,30) RETURNING id`)).rows[0].id;
await q(`INSERT INTO memberships (user_id, business_id, role) VALUES ($1,$2,'owner')`, [owner, B]);
await q(`INSERT INTO weekly_hours (business_id, owner_kind, owner_id, weekday, start_min, end_min) SELECT $1,'business',$1,d,540,1260 FROM generate_series(0,6) d`, [B]);
await q(`INSERT INTO resources (business_id, name, quantity) SELECT $1, 'Room ' || i, CASE WHEN i % 10 = 0 THEN 3 ELSE 1 END FROM generate_series(1,100) i`, [B]);
await q(`INSERT INTO services (business_id, name, duration_min, buffer_after_min, sort_order, capacity, max_party_size) SELECT $1, 'Service ' || i, (ARRAY[30,45,60,90])[1 + i % 4], 10, i, CASE WHEN i % 20 = 0 THEN 6 ELSE 1 END, CASE WHEN i % 20 = 0 THEN 3 ELSE 1 END FROM generate_series(1,100) i`, [B]);
await q(`INSERT INTO staff (business_id, display_name, sort_order) SELECT $1, 'Staff ' || i, i FROM generate_series(1,50) i`, [B]);
// every staff offers 20 services; services 1-10 use a room
await q(`INSERT INTO staff_services (business_id, staff_id, service_id)
         SELECT $1, st.id, sv.id FROM (SELECT id, row_number() OVER (ORDER BY sort_order) rn FROM staff WHERE business_id=$1) st
         JOIN (SELECT id, row_number() OVER (ORDER BY sort_order) rn FROM services WHERE business_id=$1) sv ON (sv.rn + st.rn) % 5 = 0`, [B]);
await q(`INSERT INTO service_resources (business_id, service_id, resource_id)
         SELECT $1, sv.id, r.id FROM (SELECT id, row_number() OVER (ORDER BY sort_order) rn FROM services WHERE business_id=$1) sv
         JOIN (SELECT id, row_number() OVER (ORDER BY name) rn FROM resources WHERE business_id=$1) r ON r.rn = sv.rn WHERE sv.rn <= 10`, [B]);
log('master data');
await q(`INSERT INTO customers (business_id, customer_no, name, name_normalized, email, email_normalized, phone, phone_normalized)
         SELECT $1, i, '顧客 ' || i, '顧客 ' || i, 'cust' || i || '@example.test', 'cust' || i || '@example.test', '090' || lpad(i::text, 8, '0'), '090' || lpad(i::text, 8, '0')
           FROM generate_series(1,50000) i`, [B]);
log('customers 50,000');
// bookings: 50 staff × 500 days × 8 hourly slots = 200,000. days from -400 to +99 relative to today (JST)
await q(`CREATE TEMP TABLE svc_map AS SELECT id, duration_min, row_number() OVER (ORDER BY sort_order) - 1 AS k FROM services WHERE business_id = $1 AND capacity = 1 AND id NOT IN (SELECT service_id FROM service_resources)`, [B]);
await q(`CREATE TEMP TABLE staff_map AS SELECT id, row_number() OVER (ORDER BY sort_order) - 1 AS k FROM staff WHERE business_id = $1`, [B]);
await q(`
  INSERT INTO bookings (id, business_id, ref_code, customer_id, service_id, staff_id, session_key, start_at, end_at, occupied_start, occupied_end,
                        party_size, status, source, service_snapshot)
  SELECT g.id, $1, 'L' || lpad(g.n::text, 7, '0'), c.id, s.id, st.id, 'b:' || g.id,
         g.start_at, g.start_at + interval '45 minutes', g.start_at, g.start_at + interval '55 minutes', 1,
         CASE WHEN g.start_at > now() THEN (CASE WHEN g.n % 17 = 0 THEN 'cancelled_by_customer' ELSE 'confirmed' END)
              WHEN g.n % 23 = 0 THEN 'no_show' WHEN g.n % 11 = 0 THEN 'cancelled_by_customer' WHEN g.n % 29 = 0 THEN 'cancelled_by_business' ELSE 'completed' END,
         (ARRAY['public','public','public','phone','walk_in','dm'])[1 + g.n % 6],
         jsonb_build_object('name', s_name.name, 'durationMin', 45)
    FROM (
      SELECT gen_random_uuid() AS id, row_number() OVER () AS n, st_k, day_off, slot,
             ((now() AT TIME ZONE 'Asia/Tokyo')::date + day_off + time '10:00' + slot * interval '1 hour') AT TIME ZONE 'Asia/Tokyo' AS start_at
        FROM generate_series(0,49) st_k, generate_series(-400,99) day_off, generate_series(0,7) slot
    ) g
    JOIN staff_map st ON st.k = g.st_k
    JOIN svc_map s ON s.k = (g.n % (SELECT count(*) FROM svc_map))
    JOIN services s_name ON s_name.id = s.id
    JOIN customers c ON c.business_id = $1 AND c.customer_no = 1 + (g.n * 7919) % 50000`, [B]);
log('bookings 200,000');
await q(`INSERT INTO allocations (business_id, booking_id, kind, target_id, occupied, session_key, active)
         SELECT business_id, id, 'staff', staff_id, tstzrange(occupied_start, occupied_end), session_key, status IN ('confirmed','checked_in','completed','no_show') FROM bookings WHERE business_id = $1`, [B]);
log('allocations');
await q(`INSERT INTO booking_status_history (business_id, booking_id, to_status, actor_type, at) SELECT business_id, id, 'confirmed', 'customer', start_at - interval '3 days' FROM bookings WHERE business_id = $1`, [B]);
log('status history');
// notifications: 2.5 per booking → 500,000
await q(`INSERT INTO notifications (business_id, booking_id, kind, recipient, dedupe_key, scheduled_at, status, attempts, sent_at)
         SELECT b.business_id, b.id, k.kind, 'cust@example.test', k.kind || ':' || b.id, b.start_at - interval '1 day',
                CASE WHEN b.start_at - interval '1 day' < now() THEN 'sent' ELSE 'pending' END, 1, CASE WHEN b.start_at - interval '1 day' < now() THEN b.start_at - interval '1 day' END
           FROM bookings b CROSS JOIN (VALUES ('booking_confirmed'), ('reminder')) k(kind) WHERE b.business_id = $1`, [B]);
await q(`INSERT INTO notifications (business_id, booking_id, kind, recipient, dedupe_key, scheduled_at, status, attempts, sent_at)
         SELECT business_id, id, 'owner_new_booking', 'owner@example.test', 'owner_new:' || id, start_at - interval '3 days', 'sent', 1, start_at - interval '3 days'
           FROM bookings WHERE business_id = $1 AND ref_code::text ~ '[02468]$'`, [B]);
log('notifications');
await q('ANALYZE');
const counts = (await q(`SELECT (SELECT count(*) FROM services) s, (SELECT count(*) FROM staff) st, (SELECT count(*) FROM resources) r, (SELECT count(*) FROM customers) c, (SELECT count(*) FROM bookings) b, (SELECT count(*) FROM notifications) n, (SELECT count(*) FROM allocations) a`)).rows[0];
log(`counts ${JSON.stringify(counts)}`);
await pool.end();
