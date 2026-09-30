import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNotificationsOnce } from '../../src/server/services/notifications.js';
import { basicSetup, Client, futureDate, isoAt, publicBooking, safeJson, setup, signupOwner, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

const customer = (n: number) => ({ name: `顧客${n}`, email: `c${n}@example.test`, phone: '090-0000-0000' });

describe('公開予約と競合防止（実DB）', () => {
  it('公開ページは内部情報を返さず、空き枠を返す', async () => {
    const { client, slug } = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(client);
    await client.json('PUT', `/api/admin/staff/${staffIds[0]}`, { displayName: 'Staff1', internalName: '社員番号123 内部メモ', email: 'staff-private@example.test', serviceIds: [serviceId] });
    const r = await env.app.inject({ method: 'GET', url: `/api/public/${slug}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('社員番号123');
    expect(r.body).not.toContain('staff-private@example.test');
    expect(r.body).not.toContain('internal');
    const date = futureDate(3);
    const s = await env.app.inject({ method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}` });
    const body = JSON.parse(s.body);
    expect(body.dates[date][0].start).toBe(isoAt(date, 10));
    expect(body.dates[date]).toHaveLength(15);
  });
});

describe('必須テスト（DB競合・原子性）', () => {
  it('9. 同じ10:00へ2顧客（実際は20並列）が同時確定 → 1件だけ成功、敗者は409と代替候補', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const date = futureDate(4);
    const start = isoAt(date, 10);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => publicBooking(env.app, slug, { serviceId, start, partySize: 1, customer: customer(i), idempotencyKey: randomUUID() }, `10.1.0.${i}`)),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    const lost = results.filter((r) => r.statusCode === 409);
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(19);
    const err = JSON.parse(lost[0].body).error;
    expect(err.code).toBe('SLOT_UNAVAILABLE');
    expect(err.details.alternatives.length).toBeGreaterThan(0);
    expect(err.details.alternatives.map((a: { start: string }) => a.start)).not.toContain(start);
    const n = await env.pool.query(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND status = 'confirmed'`, [businessId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('10. 確定ボタン二重送信（同じ冪等キーで並列＋再送）→ 予約は1件', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const start = isoAt(futureDate(4), 11);
    const key = randomUUID();
    const body = { serviceId, start, partySize: 1, customer: customer(1), idempotencyKey: key };
    const rs = await Promise.all([publicBooking(env.app, slug, body), publicBooking(env.app, slug, body), publicBooking(env.app, slug, body)]);
    const again = await publicBooking(env.app, slug, body);
    for (const r of [...rs, again]) expect(r.statusCode).toBe(200);
    const refs = new Set([...rs, again].map((r) => JSON.parse(r.body).refCode));
    expect(refs.size).toBe(1);
    expect([...rs, again].filter((r) => JSON.parse(r.body).replayed).length).toBe(3);
    const n = await env.pool.query(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1`, [businessId]);
    expect(n.rows[0].n).toBe(1);
  });

  it('11. 変更先の確保に失敗したら元の予約はそのまま', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const date = futureDate(5);
    const a = JSON.parse((await publicBooking(env.app, slug, { serviceId, start: isoAt(date, 10), customer: customer(1), idempotencyKey: randomUUID() })).body);
    await publicBooking(env.app, slug, { serviceId, start: isoAt(date, 14), customer: customer(2), idempotencyKey: randomUUID() });
    // try to move A onto B's time via the manage link
    const r = await env.app.inject({ method: 'POST', url: '/api/manage/reschedule', payload: { token: a.manageToken, start: isoAt(date, 14) } });
    expect(r.statusCode).toBe(409);
    const rows = await env.pool.query(`SELECT ref_code, status, start_at FROM bookings WHERE business_id = $1 ORDER BY start_at`, [businessId]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].status).toBe('confirmed');
    expect(rows.rows[0].start_at.toISOString()).toBe(isoAt(date, 10));
    const alloc = await env.pool.query(`SELECT count(*)::int AS n FROM allocations WHERE business_id = $1 AND active`, [businessId]);
    expect(alloc.rows[0].n).toBe(2);
    // and a valid move works: new slot secured, old released, link keeps working
    const ok = await env.app.inject({ method: 'POST', url: '/api/manage/reschedule', payload: { token: a.manageToken, start: isoAt(date, 10, 30) } });
    expect(ok.statusCode).toBe(200);
    const view = JSON.parse(ok.body);
    expect(view.booking.start).toBe(isoAt(date, 10, 30));
    const old = await env.pool.query(`SELECT status FROM bookings WHERE business_id = $1 AND ref_code = $2`, [businessId, a.refCode]);
    expect(old.rows[0].status).toBe('rescheduled');
    const slots = JSON.parse((await env.app.inject({ method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}` })).body);
    expect(slots.dates[date].map((s: { start: string }) => s.start)).not.toContain(isoAt(date, 10, 30));
    expect(slots.dates[date].map((s: { start: string }) => s.start)).toContain(isoAt(date, 12));
    const v2 = await env.app.inject({ method: 'POST', url: '/api/manage/view', payload: { token: a.manageToken } });
    expect(v2.statusCode).toBe(200);
  });

  it('12. キャンセルで枠が再開放され、待機候補が管理側に出る', async () => {
    const { client, slug } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const date = futureDate(6);
    const start = isoAt(date, 15);
    const a = JSON.parse((await publicBooking(env.app, slug, { serviceId, start, customer: customer(1), idempotencyKey: randomUUID() })).body);
    const before = JSON.parse((await env.app.inject({ method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}` })).body);
    expect(before.dates[date].map((s: { start: string }) => s.start)).not.toContain(start);
    const w = await env.app.inject({ method: 'POST', url: `/api/public/${slug}/waitlist`, payload: { serviceId, dateFrom: date, dateTo: date, timeFromMin: 780, timeToMin: 1080, name: '待機 太郎', email: 'wait@example.test' } });
    expect(w.statusCode).toBe(200);
    const c = await env.app.inject({ method: 'POST', url: '/api/manage/cancel', payload: { token: a.manageToken, reason: '都合' } });
    expect(c.statusCode).toBe(200);
    expect(JSON.parse(c.body).booking.status).toBe('cancelled_by_customer');
    const after = JSON.parse((await env.app.inject({ method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}` })).body);
    expect(after.dates[date].map((s: { start: string }) => s.start)).toContain(start);
    const wl = await client.json('GET', '/api/admin/waitlist');
    expect(wl.entries[0].lastMatchAt).not.toBeNull();
    const cand = await client.json('GET', `/api/admin/waitlist/${wl.entries[0].id}/candidates`);
    expect(cand.slots.map((s: { start: string }) => s.start)).toContain(start);
    // waitlist never auto-books
    const bookings = await client.json('GET', `/api/admin/bookings?from=${date}&to=${date}&status=confirmed`);
    expect(bookings.total).toBe(0);
  });

  it('13. 定員6/予約5 → 2名は不可、1名は可、その後満席（開催枠モード）', async () => {
    const { client, slug } = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(client, { capacity: 6, maxPartySize: 6, bookingMode: 'sessions', durationMin: 120 });
    const date = futureDate(7);
    const occ = await client.json('POST', '/api/admin/occurrences', { serviceId, staffId: staffIds[0], start: isoAt(date, 13) });
    for (const [i, p] of [[1, 3], [2, 2]] as const) {
      const r = await publicBooking(env.app, slug, { serviceId, occurrenceId: occ.id, partySize: p, customer: customer(i), idempotencyKey: randomUUID() });
      expect(r.statusCode).toBe(200);
    }
    const two = await publicBooking(env.app, slug, { serviceId, occurrenceId: occ.id, partySize: 2, customer: customer(3), idempotencyKey: randomUUID() });
    expect(two.statusCode).toBe(409);
    expect(JSON.parse(two.body).error.details.reasons[0].code).toBe('CAPACITY_FULL');
    const one = await publicBooking(env.app, slug, { serviceId, occurrenceId: occ.id, partySize: 1, customer: customer(4), idempotencyKey: randomUUID() });
    expect(one.statusCode).toBe(200);
    const full = await publicBooking(env.app, slug, { serviceId, occurrenceId: occ.id, partySize: 1, customer: customer(5), idempotencyKey: randomUUID() });
    expect(full.statusCode).toBe(409);
    const slots = JSON.parse((await env.app.inject({ method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}` })).body);
    expect(slots.dates[date]).toBeUndefined();
  });

  it('13b. 定員制の最後の1席を10人が同時に取り合う → 1名だけ成功', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(client, { capacity: 6, maxPartySize: 6, bookingMode: 'sessions' });
    const occ = await client.json('POST', '/api/admin/occurrences', { serviceId, staffId: staffIds[0], start: isoAt(futureDate(8), 13) });
    expect((await publicBooking(env.app, slug, { serviceId, occurrenceId: occ.id, partySize: 5, customer: customer(0), idempotencyKey: randomUUID() })).statusCode).toBe(200);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => publicBooking(env.app, slug, { serviceId, occurrenceId: occ.id, partySize: 1, customer: customer(i + 1), idempotencyKey: randomUUID() }, `10.2.0.${i}`)));
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const sum = await env.pool.query(`SELECT sum(party_size)::int AS n FROM bookings WHERE business_id = $1 AND status = 'confirmed'`, [businessId]);
    expect(sum.rows[0].n).toBe(6);
  });

  it('13c. slotsモードの定員制（同時刻に相乗り）も同じ上限', async () => {
    const { client, slug } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client, { capacity: 6, maxPartySize: 6 });
    const start = isoAt(futureDate(8), 15);
    expect((await publicBooking(env.app, slug, { serviceId, start, partySize: 5, customer: customer(0), idempotencyKey: randomUUID() })).statusCode).toBe(200);
    expect((await publicBooking(env.app, slug, { serviceId, start, partySize: 2, customer: customer(1), idempotencyKey: randomUUID() })).statusCode).toBe(409);
    expect((await publicBooking(env.app, slug, { serviceId, start, partySize: 1, customer: customer(2), idempotencyKey: randomUUID() })).statusCode).toBe(200);
  });

  it('電話予約（手動予約）も同じ競合チェック。強制予約でも二重予約は作れない', async () => {
    const { client, slug } = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(client);
    const start = isoAt(futureDate(9), 10);
    expect((await publicBooking(env.app, slug, { serviceId, start, customer: customer(1), idempotencyKey: randomUUID() })).statusCode).toBe(200);
    const manual = await client.post('/api/admin/bookings', { serviceId, staffId: staffIds[0], start, customer: { name: '電話 客' }, source: 'phone', idempotencyKey: randomUUID() });
    expect(manual.statusCode).toBe(409);
    const forced = await client.post('/api/admin/bookings', { serviceId, staffId: staffIds[0], start, customer: { name: '電話 客' }, source: 'phone', force: true, forcedReason: 'テスト', idempotencyKey: randomUUID() });
    expect(forced.statusCode).toBe(409);
    // outside hours: normal manual booking refused, forced allowed (no conflicts) and audited
    const early = isoAt(futureDate(9), 8);
    expect((await client.post('/api/admin/bookings', { serviceId, staffId: staffIds[0], start: early, customer: { name: '早朝 客' }, source: 'phone', idempotencyKey: randomUUID() })).statusCode).toBe(409);
    const f2 = await client.post('/api/admin/bookings', { serviceId, staffId: staffIds[0], start: early, customer: { name: '早朝 客' }, source: 'phone', force: true, forcedReason: '特別対応', idempotencyKey: randomUUID() });
    expect(f2.statusCode).toBe(200);
    const audit = await client.json('GET', '/api/admin/audit?action=booking.force');
    expect(audit.logs[0].summary.forcedReason).toBe('特別対応');
  });

  it('DB排他制約：アプリ層を迂回してもスタッフの重複占有は拒否される', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(client);
    const start = isoAt(futureDate(10), 10);
    const b = JSON.parse((await publicBooking(env.app, slug, { serviceId, start, customer: customer(1), idempotencyKey: randomUUID() })).body);
    const row = (await env.pool.query(`SELECT id FROM bookings WHERE business_id = $1 AND ref_code = $2`, [businessId, b.refCode])).rows[0];
    await expect(
      env.pool.query(`INSERT INTO allocations (business_id, booking_id, kind, target_id, occupied, session_key) VALUES ($1,$2,'staff',$3, tstzrange($4, $5), 'b:other')`, [
        businessId,
        row.id,
        staffIds[0],
        new Date(Date.parse(start) + 30 * 60_000),
        new Date(Date.parse(start) + 90 * 60_000),
      ]),
    ).rejects.toThrow(/allocations_staff_no_overlap/);
  });

  it('15. 通知Jobを再実行しても同一リマインドは二重送信されない', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const start = isoAt(futureDate(3), 12);
    await publicBooking(env.app, slug, { serviceId, start, customer: customer(9001), idempotencyKey: randomUUID() });
    const rows = await env.pool.query(`SELECT kind, scheduled_at FROM notifications WHERE business_id = $1 ORDER BY kind`, [businessId]);
    expect(rows.rows.map((r) => r.kind).sort()).toEqual(['booking_confirmed', 'owner_new_booking', 'reminder']);
    // run the job at a time after the reminder is due, 3 times + concurrently
    const due = new Date(Date.parse(start) - 60 * 60_000);
    const before = env.mailer.outbox.length;
    await Promise.all([runNotificationsOnce(env.pool, env.cfg, env.mailer, due), runNotificationsOnce(env.pool, env.cfg, env.mailer, due)]);
    await runNotificationsOnce(env.pool, env.cfg, env.mailer, due);
    const mails = env.mailer.outbox.slice(before).filter((m) => m.to === 'c9001@example.test');
    expect(mails.filter((m) => m.subject.includes('ご予約日時のお知らせ'))).toHaveLength(1);
    expect(mails.filter((m) => m.subject.includes('ご予約を承りました'))).toHaveLength(1);
    const st = await env.pool.query(`SELECT kind, status, attempts FROM notifications WHERE business_id = $1`, [businessId]);
    for (const r of st.rows) expect([r.kind, r.status, r.attempts]).toEqual([r.kind, 'sent', 1]);
    // enqueueing the same reminder again is a no-op (unique dedupe key)
    const again = await env.pool.query(
      `INSERT INTO notifications (business_id, booking_id, kind, recipient, dedupe_key, scheduled_at)
       SELECT business_id, booking_id, kind, recipient, dedupe_key, scheduled_at FROM notifications WHERE business_id = $1 AND kind = 'reminder' ON CONFLICT DO NOTHING`,
      [businessId],
    );
    expect(again.rowCount).toBe(0);
    // the confirmation mail contains a manage link (fragment token) and no HTML
    const conf = mails.find((m) => m.subject.includes('ご予約を承りました'))!;
    expect(conf.text).toMatch(/http:\/\/test\.local\/manage#t=[A-Za-z0-9_-]{43}/);
    expect(conf.text).not.toMatch(/<[a-z]/i);
  });

  it('通知失敗は記録され、バックオフ後に再試行、成功後は再送しない', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    await publicBooking(env.app, slug, { serviceId, start: isoAt(futureDate(3), 13), customer: customer(7), idempotencyKey: randomUUID() });
    const failing = { send: async () => { throw new Error('SMTP 421 try later'); } };
    const now = new Date();
    const r1 = await runNotificationsOnce(env.pool, env.cfg, failing, now);
    expect(r1.failed).toBeGreaterThan(0);
    const f = await env.pool.query(`SELECT status, attempts, last_error, next_attempt_at FROM notifications WHERE business_id = $1 AND kind = 'booking_confirmed'`, [businessId]);
    expect(f.rows[0]).toMatchObject({ status: 'failed', attempts: 1, last_error: 'SMTP 421 try later' });
    // manage tokens minted for the failed mail are revoked
    const toks = await env.pool.query(`SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active FROM manage_tokens t JOIN bookings b ON b.id = t.booking_id WHERE b.business_id = $1`, [businessId]);
    expect(toks.rows[0].active).toBe(1); // only the one shown on the completion page
    const r2 = await runNotificationsOnce(env.pool, env.cfg, env.mailer, new Date(now.getTime() + 2 * 60_000));
    expect(r2.sent).toBeGreaterThan(0);
    const r3 = await runNotificationsOnce(env.pool, env.cfg, env.mailer, new Date(now.getTime() + 10 * 60_000));
    expect(r3.claimed).toBe(0);
    // a crashed send ("sending" for > 10 min) is marked unknown, never auto-resent
    await env.pool.query(`UPDATE notifications SET status = 'sending', claimed_at = now() - interval '11 minutes' WHERE business_id = $1 AND kind = 'owner_new_booking'`, [businessId]);
    const r4 = await runNotificationsOnce(env.pool, env.cfg, env.mailer);
    expect(r4.staleMarkedUnknown).toBe(1);
    const u = await env.pool.query(`SELECT status FROM notifications WHERE business_id = $1 AND kind = 'owner_new_booking'`, [businessId]);
    expect(u.rows[0].status).toBe('unknown');
  });

  it('キャンセル後はリマインドが送られない', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const start = isoAt(futureDate(3), 16);
    const b = JSON.parse((await publicBooking(env.app, slug, { serviceId, start, customer: customer(8), idempotencyKey: randomUUID() })).body);
    await env.app.inject({ method: 'POST', url: '/api/manage/cancel', payload: { token: b.manageToken } });
    const rem = await env.pool.query(`SELECT status FROM notifications WHERE business_id = $1 AND kind = 'reminder'`, [businessId]);
    expect(rem.rows[0].status).toBe('cancelled');
  });

  it('事前質問のスナップショット：質問を後で編集しても過去回答の意味は変わらない', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const q = await client.json('POST', '/api/admin/questions', { type: 'single_choice', label: '希望コース', required: true, options: [{ id: 'a', label: '初級' }, { id: 'b', label: '上級' }] });
    const missing = await publicBooking(env.app, slug, { serviceId, start: isoAt(futureDate(3), 10), customer: customer(1), idempotencyKey: randomUUID() });
    expect(missing.statusCode).toBe(400);
    expect(JSON.parse(missing.body).error.details.fieldErrors[q.id]).toBeTruthy();
    const ok = await publicBooking(env.app, slug, { serviceId, start: isoAt(futureDate(3), 10), customer: customer(1), idempotencyKey: randomUUID(), answers: [{ questionId: q.id, value: 'b' }] });
    expect(ok.statusCode).toBe(200);
    await client.json('PUT', `/api/admin/questions/${q.id}`, { type: 'single_choice', label: 'コース（改定）', required: true, options: [{ id: 'a', label: '入門' }, { id: 'b', label: '中級' }] });
    const row = (await env.pool.query(`SELECT answers FROM bookings WHERE business_id = $1`, [businessId])).rows[0];
    expect(row.answers[0]).toMatchObject({ label: '希望コース', display: '上級', value: 'b' });
  });

  it('18. ブロック登録は既存予約を消さず警告を返し、以後その時間は予約不可', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(client);
    const date = futureDate(11);
    await publicBooking(env.app, slug, { serviceId, start: isoAt(date, 11), customer: customer(1), idempotencyKey: randomUUID() });
    const blk = await client.json('POST', '/api/admin/blocks', { scope: 'staff', targetId: staffIds[0], start: isoAt(date, 10), end: isoAt(date, 13), reason: '私用' });
    expect(blk.overlappingBookings).toHaveLength(1);
    const n = await env.pool.query(`SELECT count(*)::int AS n FROM bookings WHERE business_id = $1 AND status = 'confirmed'`, [businessId]);
    expect(n.rows[0].n).toBe(1);
    const s = JSON.parse((await env.app.inject({ method: 'GET', url: `/api/public/${slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}` })).body);
    const starts = s.dates[date].map((x: { start: string }) => x.start);
    expect(starts).not.toContain(isoAt(date, 10));
    expect(starts).not.toContain(isoAt(date, 12));
    expect(starts).toContain(isoAt(date, 13));
  });

  it('当日受付：来店→完了、無断欠席は開始後のみ、状態履歴に誰がいつ', async () => {
    const { client, businessId } = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(client);
    const soon = new Date(Date.now() + 5 * 60_000);
    soon.setSeconds(0, 0);
    const b = await client.json('POST', '/api/admin/bookings', { serviceId, staffId: staffIds[0], start: soon.toISOString(), customer: { name: '店頭 客' }, source: 'walk_in', force: true, forcedReason: '飛び込み', idempotencyKey: randomUUID() });
    const ns = await client.post(`/api/admin/bookings/${b.id}/status`, { to: 'no_show' });
    expect(ns.statusCode).toBe(400);
    expect((await client.post(`/api/admin/bookings/${b.id}/status`, { to: 'checked_in' })).statusCode).toBe(200);
    expect((await client.post(`/api/admin/bookings/${b.id}/status`, { to: 'completed' })).statusCode).toBe(200);
    const d = await client.json('GET', `/api/admin/bookings/${b.id}`);
    expect(d.history.map((h: { to: string }) => h.to)).toEqual(['confirmed', 'checked_in', 'completed']);
    expect(d.history[1].actorName).toBeTruthy();
    // next booking from completion: same customer + service, time re-checked
    const next = await client.post('/api/admin/bookings', { serviceId, staffId: staffIds[0], start: isoAt(futureDate(14), 10), customerId: d.booking.customerId, source: 'walk_in', idempotencyKey: randomUUID() });
    expect(next.statusCode).toBe(200);
    const cust = await client.json('GET', `/api/admin/customers/${d.booking.customerId}`);
    expect(cust.stats.total).toBe(2);
    expect(cust.stats.completed).toBe(1);
    void businessId;
  });

  it('予約管理リンク：推測不可・失効・再発行、連番/予約番号だけではアクセス不可', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const b = JSON.parse((await publicBooking(env.app, slug, { serviceId, start: isoAt(futureDate(3), 15), customer: customer(3), idempotencyKey: randomUUID() })).body);
    expect(b.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await env.pool.query(`SELECT token_hash FROM manage_tokens t JOIN bookings bk ON bk.id = t.booking_id WHERE bk.business_id = $1`, [businessId]);
    expect(stored.rows[0].token_hash).not.toBe(b.manageToken);
    for (const t of [b.refCode, b.refCode.replace('-', ''), 'x'.repeat(43), b.manageToken.slice(0, -1) + (b.manageToken.endsWith('A') ? 'B' : 'A')]) {
      const r = await env.app.inject({ method: 'POST', url: '/api/manage/view', payload: { token: t } });
      expect(r.statusCode).toBe(404);
    }
    const id = (await env.pool.query(`SELECT id FROM bookings WHERE business_id = $1`, [businessId])).rows[0].id;
    const re = await client.json('POST', `/api/admin/bookings/${id}/manage-link`, { sendEmail: false });
    expect(re.revoked).toBe(1);
    expect(re.url).toMatch(/\/manage#t=/);
    expect((await env.app.inject({ method: 'POST', url: '/api/manage/view', payload: { token: b.manageToken } })).statusCode).toBe(404);
    const newTok = re.url.split('#t=')[1];
    expect((await env.app.inject({ method: 'POST', url: '/api/manage/view', payload: { token: newTok } })).statusCode).toBe(200);
    await env.pool.query(`UPDATE manage_tokens SET expires_at = now() - interval '1 minute'`);
    expect((await env.app.inject({ method: 'POST', url: '/api/manage/view', payload: { token: newTok } })).statusCode).toBe(404);
  });

  it('顧客のキャンセル締切を過ぎたら管理リンクからは不可（事業者側は可）', async () => {
    const { client, slug, businessId } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const s = await client.json('GET', '/api/admin/settings');
    await client.json('PUT', '/api/admin/settings', { ...s, cancelDeadlineMin: 1440 * 3, changeDeadlineMin: 1440 * 3 });
    const b = JSON.parse((await publicBooking(env.app, slug, { serviceId, start: isoAt(futureDate(2), 15), customer: customer(4), idempotencyKey: randomUUID() })).body);
    const v = JSON.parse((await env.app.inject({ method: 'POST', url: '/api/manage/view', payload: { token: b.manageToken } })).body);
    expect(v.booking.canCancel).toBe(false);
    expect((await env.app.inject({ method: 'POST', url: '/api/manage/cancel', payload: { token: b.manageToken } })).statusCode).toBe(403);
    const id = (await env.pool.query(`SELECT id FROM bookings WHERE business_id = $1`, [businessId])).rows[0].id;
    expect((await client.post(`/api/admin/bookings/${id}/cancel`, { by: 'customer', reason: '電話で連絡あり' })).statusCode).toBe(200);
  });

  it('公開予約の入力検証とbot対策（ハニーポット・送信速度・必須電話）', async () => {
    const { client, slug } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const start = isoAt(futureDate(3), 10);
    const hp = await publicBooking(env.app, slug, { serviceId, start, customer: customer(1), idempotencyKey: randomUUID(), website: 'http://spam' });
    expect(hp.statusCode).toBe(400);
    const fast = await publicBooking(env.app, slug, { serviceId, start, customer: customer(1), idempotencyKey: randomUUID(), elapsedMs: 300 });
    expect(fast.statusCode).toBe(400);
    const badEmail = await publicBooking(env.app, slug, { serviceId, start, customer: { name: 'x', email: 'not-an-email' }, idempotencyKey: randomUUID() });
    expect(badEmail.statusCode).toBe(400);
    const s = await client.json('GET', '/api/admin/settings');
    await client.json('PUT', '/api/admin/settings', { ...s, phoneRequirement: 'required' });
    const noPhone = await publicBooking(env.app, slug, { serviceId, start, customer: { name: 'x', email: 'x@example.test' }, idempotencyKey: randomUUID() });
    expect(noPhone.statusCode).toBe(400);
    expect(safeJson(noPhone.body).error.details.fieldErrors['customer.phone']).toBeTruthy();
  });

  it('公開ページのレート制限（同一IPからの大量予約）', async () => {
    const { client, slug } = await signupOwner(env.app);
    const { serviceId } = await basicSetup(client);
    const date = futureDate(20);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await publicBooking(env.app, slug, { serviceId, start: isoAt(date, 10 + (i % 8)), customer: customer(100 + i), idempotencyKey: randomUUID() }, '10.9.9.9');
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('非公開の事業者ページは404', async () => {
    const { client, slug } = await signupOwner(env.app);
    await basicSetup(client);
    const s = await client.json('GET', '/api/admin/settings');
    await client.json('PUT', '/api/admin/settings', { ...s, published: false });
    expect((await env.app.inject({ method: 'GET', url: `/api/public/${slug}` })).statusCode).toBe(404);
  });
});

void Client;
