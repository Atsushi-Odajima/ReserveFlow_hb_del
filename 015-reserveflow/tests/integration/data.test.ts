import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSample } from '../../src/server/seed/sample.js';
import { Client, basicSetup, futureDate, isoAt, publicBooking, setup, signupOwner, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

/** Business content with ids replaced by stable natural keys, for comparing source and restored copies. */
async function snapshot(businessId: string) {
  const q = async (sql: string) => (await env.pool.query(sql, [businessId])).rows;
  return {
    settings: (await q(`SELECT name, brand_name, timezone, slot_interval_min, min_notice_min, max_advance_days, notes, theme_color FROM businesses WHERE id = $1`))[0],
    hours: await q(`SELECT owner_kind, weekday, start_min, end_min FROM weekly_hours WHERE business_id = $1 ORDER BY owner_kind, weekday, start_min`),
    services: await q(`SELECT name, duration_min, buffer_before_min, buffer_after_min, capacity, booking_mode FROM services WHERE business_id = $1 ORDER BY name`),
    staff: await q(`SELECT display_name, uses_business_hours, (SELECT array_agg(sv.name ORDER BY sv.name) FROM staff_services x JOIN services sv ON sv.id = x.service_id WHERE x.staff_id = s.id) AS svcs FROM staff s WHERE business_id = $1 ORDER BY display_name`),
    resources: await q(`SELECT name, quantity FROM resources WHERE business_id = $1 ORDER BY name`),
    exceptions: await q(`SELECT date, kind, label, intervals FROM date_exceptions WHERE business_id = $1 ORDER BY date`),
    blocks: await q(`SELECT scope, start_at, end_at, reason FROM blocks WHERE business_id = $1 ORDER BY start_at`),
    customers: await q(`SELECT customer_no, name, email, phone FROM customers WHERE business_id = $1 ORDER BY customer_no`),
    bookings: (await q(
      `SELECT b.ref_code, b.status, b.start_at, b.end_at, b.party_size, c.customer_no, s.display_name AS staff, b.answers, b.service_snapshot->>'name' AS svc,
              (SELECT ref_code FROM bookings x WHERE x.id = b.rescheduled_to_id) AS moved_to
         FROM bookings b JOIN customers c ON c.id = b.customer_id LEFT JOIN staff s ON s.id = b.staff_id WHERE b.business_id = $1 ORDER BY b.ref_code`,
    )).map((b) => ({ ...b, answers: b.answers.map(({ questionId, ...rest }: { questionId: string }) => (void questionId, rest)) })),
    history: await q(`SELECT b.ref_code, h.from_status, h.to_status, h.at FROM booking_status_history h JOIN bookings b ON b.id = h.booking_id WHERE h.business_id = $1 ORDER BY b.ref_code, h.at, h.to_status`),
    allocations: await q(`SELECT a.kind, a.occupied::text, a.active FROM allocations a WHERE a.business_id = $1 ORDER BY a.occupied::text, a.kind`),
    occurrences: await q(`SELECT start_at, capacity, status FROM session_occurrences WHERE business_id = $1 ORDER BY start_at`),
    questions: await q(`SELECT type, label, options FROM questions WHERE business_id = $1 ORDER BY sort_order`),
    waitlist: await q(`SELECT name, date_from, status FROM waitlist_entries WHERE business_id = $1 ORDER BY name`),
    notifications: await q(`SELECT kind, recipient FROM notifications WHERE business_id = $1 ORDER BY kind, recipient`),
  };
}

describe('バックアップ/復元', () => {
  it('E2E-7相当: サンプル事業者をバックアップ → 空の事業者へ復元 → 内容一致', async () => {
    const sample = await seedSample(env.pool, { ownerEmail: 'sample-owner@example.test', ownerPassword: 'sample-password-123', slug: 'sample-backup' });
    const src = new Client(env.app);
    await src.login('sample-owner@example.test', 'sample-password-123');
    const file = await src.json('GET', '/api/admin/backup');
    expect(file.format).toBe('reserveflow-backup');
    expect(file.schemaVersion).toBe(1);
    expect(file.appVersion).toBeTruthy();
    expect(file.counts.bookings).toBeGreaterThan(5);
    const json = JSON.stringify(file);
    expect(json).not.toContain('password_hash');
    expect(json).not.toContain('token_hash');

    // fresh, empty target (new "environment")
    const T = await signupOwner(env.app);
    const pre = await T.client.json('POST', '/api/admin/restore/preview', { file });
    expect(pre.ok).toBe(true);
    const res = await T.client.json('POST', '/api/admin/restore/commit', { file, confirm: true });
    expect(res.counts.bookings).toBe(file.counts.bookings);
    const a = await snapshot(sample.businessId);
    const b = await snapshot(T.businessId);
    for (const k of Object.keys(a)) expect([k, (b as any)[k]]).toEqual([k, (a as any)[k]]);
    // the restored copy still enforces the booking engine (occupancy restored)
    const occ = (await env.pool.query(`SELECT count(*)::int AS n FROM allocations WHERE business_id = $1 AND active`, [T.businessId])).rows[0].n;
    expect(occ).toBeGreaterThan(0);
    // restoring again into a non-empty business is refused and leaves data unchanged
    const again = await T.client.post('/api/admin/restore/commit', { file, confirm: true });
    expect(again.statusCode).toBe(409);
    expect(await snapshot(T.businessId)).toEqual(b);
  });

  it('改ざん・件数不一致・新しい形式のファイルは復元前検証で拒否され、現行データは維持', async () => {
    const A = await signupOwner(env.app);
    await basicSetup(A.client);
    const file = await A.client.json('GET', '/api/admin/backup');
    const T = await signupOwner(env.app);
    const tampered = structuredClone(file);
    tampered.data.services[0].name = '改ざん';
    expect((await T.client.json('POST', '/api/admin/restore/preview', { file: tampered })).ok).toBe(false);
    const wrongCount = structuredClone(file);
    wrongCount.counts.services = 99;
    expect((await T.client.json('POST', '/api/admin/restore/preview', { file: wrongCount })).ok).toBe(false);
    const future = structuredClone(file);
    future.schemaVersion = 999;
    expect((await T.client.json('POST', '/api/admin/restore/preview', { file: future })).ok).toBe(false);
    expect((await T.client.post('/api/admin/restore/commit', { file: tampered, confirm: true })).statusCode).toBe(400);
    const svc = (await env.pool.query(`SELECT count(*)::int AS n FROM services WHERE business_id = $1`, [T.businessId])).rows[0].n;
    expect(svc).toBe(0);
  });

  it('途中でDBエラーが起きても全体がロールバックされる', async () => {
    const A = await signupOwner(env.app);
    const { serviceId } = await basicSetup(A.client);
    await publicBooking(env.app, A.slug, { serviceId, start: isoAt(futureDate(3), 10), customer: { name: 'x', email: 'rb@example.test' }, idempotencyKey: randomUUID() });
    const file = await A.client.json('GET', '/api/admin/backup');
    // break a late table row in a way validation cannot detect (invalid enum value) → DB error mid-restore
    file.data.audit_logs[0].actor_type = 'hacker';
    const { sha256Hex } = await import('../../src/server/lib/crypto.js');
    file.sha256 = sha256Hex(JSON.stringify({ settings: file.settings, logo: file.logoBase64 ?? null, data: file.data }));
    const T = await signupOwner(env.app);
    const r = await T.client.post('/api/admin/restore/commit', { file, confirm: true });
    expect(r.statusCode).toBe(500);
    for (const t of ['services', 'staff', 'customers', 'bookings', 'allocations'])
      expect((await env.pool.query(`SELECT count(*)::int AS n FROM ${t} WHERE business_id = $1`, [T.businessId])).rows[0].n).toBe(0);
  });
});

describe('CSV取込（プレビュー→検証→確定、二重取込防止）', () => {
  it('顧客CSV', async () => {
    const A = await signupOwner(env.app);
    const csv = '﻿氏名,メール,電話,メモ,タグ\r\n山田 花子,hanako@example.test,090-1,メモ,VIP;紹介\r\n,bad,,,\r\n鈴木 一郎,,03-1,,\r\n';
    const p = await A.client.json('POST', '/api/admin/import/customers/preview', { csv });
    expect(p.total).toBe(3);
    expect(p.errorRows).toBe(1);
    expect((await A.client.post('/api/admin/import/customers/commit', { csv, fileHash: p.fileHash })).statusCode).toBe(400);
    const fixed = csv.replace(',bad,,,\r\n', '');
    const p2 = await A.client.json('POST', '/api/admin/import/customers/preview', { csv: fixed });
    expect(p2.valid).toBe(2);
    const c = await A.client.json('POST', '/api/admin/import/customers/commit', { csv: fixed, fileHash: p2.fileHash });
    expect(c.imported).toBe(2);
    const again = await A.client.post('/api/admin/import/customers/commit', { csv: fixed, fileHash: p2.fileHash });
    expect(again.statusCode).toBe(409);
    const p3 = await A.client.json('POST', '/api/admin/import/customers/preview', { csv: fixed });
    expect(p3.alreadyImportedAt).not.toBeNull();
    expect(p3.duplicateRows).toBe(2);
    const list = await A.client.json('GET', '/api/admin/customers');
    expect(list.total).toBe(2);
    const hanako = list.customers.find((x: { name: string }) => x.name === '山田 花子');
    expect(hanako.tags).toEqual(['VIP', '紹介']);
  });

  it('サービスCSV', async () => {
    const A = await signupOwner(env.app);
    const tpl = await A.client.get('/api/admin/templates/services.csv');
    const p = await A.client.json('POST', '/api/admin/import/services/preview', { csv: tpl.body });
    expect(p.valid).toBe(1);
    await A.client.json('POST', '/api/admin/import/services/commit', { csv: tpl.body, fileHash: p.fileHash });
    const s = await A.client.json('GET', '/api/admin/services');
    expect(s.services[0]).toMatchObject({ name: '60分 個人レッスン', durationMin: 60, bufferBeforeMin: 10, priceText: '6,000円' });
  });
});

describe('顧客台帳', () => {
  it('重複候補は表示のみで自動統合しない／削除は匿名化で履歴整合性を保つ', async () => {
    const A = await signupOwner(env.app);
    const { serviceId } = await basicSetup(A.client);
    const d = futureDate(3);
    await publicBooking(env.app, A.slug, { serviceId, start: isoAt(d, 10), customer: { name: '山田 花子', email: 'dup@example.test' }, idempotencyKey: randomUUID() });
    await publicBooking(env.app, A.slug, { serviceId, start: isoAt(d, 12), customer: { name: '山田　花子', email: 'DUP@example.test' }, idempotencyKey: randomUUID() }); // same person (normalized)
    await publicBooking(env.app, A.slug, { serviceId, start: isoAt(d, 14), customer: { name: '別人 太郎', email: 'dup@example.test' }, idempotencyKey: randomUUID() }); // same email, other name
    const list = await A.client.json('GET', '/api/admin/customers');
    expect(list.total).toBe(2);
    const hanako = list.customers.find((c: { name: string }) => c.name === '山田 花子');
    expect(hanako.total).toBe(2);
    const detail = await A.client.json('GET', `/api/admin/customers/${hanako.id}`);
    expect(detail.duplicateCandidates).toHaveLength(1);
    // anonymize requires no upcoming bookings
    expect((await A.client.post(`/api/admin/customers/${hanako.id}/anonymize`, { confirm: true })).statusCode).toBe(400);
    const ids = (await env.pool.query(`SELECT id FROM bookings WHERE customer_id = $1`, [hanako.id])).rows;
    for (const b of ids) await A.client.json('POST', `/api/admin/bookings/${b.id}/cancel`, { by: 'business' });
    expect((await A.client.post(`/api/admin/customers/${hanako.id}/anonymize`, { confirm: true })).statusCode).toBe(200);
    const after = await A.client.json('GET', `/api/admin/customers/${hanako.id}`);
    expect(after.customer.name).toBe('削除済みの顧客');
    expect(after.customer.email).toBeNull();
    expect(after.stats.cancelledByBusiness).toBe(2);
    const audit = await A.client.json('GET', '/api/admin/audit?action=customer.delete');
    expect(JSON.stringify(audit.logs[0].summary)).not.toContain('dup@example.test');
  });
});

describe('繰り返し開催枠', () => {
  it('週次ルール生成・個別変更/休止・ルール変更で予約済み/個別変更回は保持', async () => {
    const A = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(A.client, { capacity: 6, maxPartySize: 6, bookingMode: 'sessions' });
    const today = futureDate(0);
    const r = await A.client.json('POST', '/api/admin/recurrences', { serviceId, staffId: staffIds[0], freq: 'weekly', weekdays: [2], startTimeMin: 18 * 60, startDate: today });
    expect(r.result.created).toBeGreaterThanOrEqual(8);
    const occs = (await env.pool.query(`SELECT id, start_at FROM session_occurrences WHERE rule_id = $1 ORDER BY start_at`, [r.id])).rows;
    // book the 1st, modify the 2nd, cancel the 3rd
    const bk = await publicBooking(env.app, A.slug, { serviceId, occurrenceId: occs[0].id, partySize: 2, customer: { name: 'r', email: 'r@example.test' }, idempotencyKey: randomUUID() });
    expect(bk.statusCode).toBe(200);
    await A.client.json('PUT', `/api/admin/occurrences/${occs[1].id}`, { capacity: 4, note: '特別回' });
    expect((await A.client.post(`/api/admin/occurrences/${occs[0].id}/cancel`, {})).statusCode).toBe(409); // has bookings → needs confirmation
    await A.client.json('POST', `/api/admin/occurrences/${occs[2].id}/cancel`, {});
    // change rule to Thursday 19:00
    const u = await A.client.json('PUT', `/api/admin/recurrences/${r.id}`, { serviceId, staffId: staffIds[0], freq: 'weekly', weekdays: [4], startTimeMin: 19 * 60, startDate: today });
    expect(u.kept).toBe(3); // booked + modified + cancelled(modified) stay
    const kept = (await env.pool.query(`SELECT id FROM session_occurrences WHERE id = ANY($1)`, [[occs[0].id, occs[1].id, occs[2].id]])).rows;
    expect(kept).toHaveLength(3);
    const booked = (await env.pool.query(`SELECT start_at FROM session_occurrences WHERE id = $1`, [occs[0].id])).rows[0];
    expect(booked.start_at.toISOString()).toBe(occs[0].start_at.toISOString());
    // capacity cannot drop below booked seats
    expect((await A.client.put(`/api/admin/occurrences/${occs[0].id}`, { capacity: 1 })).statusCode).toBe(409);
    // occurrence holds the staff: a private booking can't take that time
    const svc2 = await A.client.json('POST', '/api/admin/services', { name: '個別', durationMin: 60, staffIds: [staffIds[0]] });
    const clash = await A.client.post('/api/admin/bookings', { serviceId: svc2.id, staffId: staffIds[0], start: occs[0].start_at.toISOString(), customer: { name: 'x' }, idempotencyKey: randomUUID() });
    expect(clash.statusCode).toBe(409);
  });

  it('月次ルール（第2土曜・毎月15日）の日付計算', async () => {
    const { ruleDates } = await import('../../src/server/services/recurrence.js');
    expect(ruleDates({ freq: 'monthly_nth_weekday', interval_n: 1, weekdays: [6], nth: 2, month_day: null, start_date: '2026-10-01', end_date: null }, '2026-10-01', '2026-12-31')).toEqual(['2026-10-10', '2026-11-14', '2026-12-12']);
    expect(ruleDates({ freq: 'monthly_nth_weekday', interval_n: 1, weekdays: [5], nth: -1, month_day: null, start_date: '2026-10-01', end_date: null }, '2026-10-01', '2026-11-30')).toEqual(['2026-10-30', '2026-11-27']);
    expect(ruleDates({ freq: 'monthly_day', interval_n: 1, weekdays: [], nth: null, month_day: 15, start_date: '2026-10-01', end_date: '2026-11-30' }, '2026-10-01', '2026-12-31')).toEqual(['2026-10-15', '2026-11-15']);
    expect(ruleDates({ freq: 'weekly', interval_n: 2, weekdays: [2], nth: null, month_day: null, start_date: '2026-10-06', end_date: null }, '2026-10-01', '2026-10-31')).toEqual(['2026-10-06', '2026-10-20']);
  });
});

describe('分析', () => {
  it('期間・分母を明示して集計', async () => {
    const A = await signupOwner(env.app);
    const { serviceId } = await basicSetup(A.client);
    const d = futureDate(3);
    const b1 = JSON.parse((await publicBooking(env.app, A.slug, { serviceId, start: isoAt(d, 10), customer: { name: 'a', email: 'a1@example.test' }, idempotencyKey: randomUUID() })).body);
    await publicBooking(env.app, A.slug, { serviceId, start: isoAt(d, 12), customer: { name: 'b', email: 'b1@example.test' }, idempotencyKey: randomUUID() });
    await env.app.inject({ method: 'POST', url: '/api/manage/cancel', payload: { token: b1.manageToken } });
    const an = await A.client.json('GET', `/api/admin/analytics?from=${d}&to=${d}`);
    expect(an.totals).toMatchObject({ bookings: 2, cancelledByCustomer: 1 });
    expect(an.rates.cancelRate.value).toBe(50);
    expect(an.rates.cancelRate.formula).toContain('÷');
    expect(an.bySource[0]).toMatchObject({ key: 'public', bookings: 2 });
  });
});
