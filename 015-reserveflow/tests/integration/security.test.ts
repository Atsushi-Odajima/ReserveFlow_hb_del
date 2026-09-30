import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCsv, csvSafe } from '../../src/server/lib/csv.js';
import { renderTemplate } from '../../src/server/services/notifications.js';
import { icsText } from '../../src/server/services/ics.js';
import { basicSetup, Client, futureDate, isoAt, publicBooking, setup, signupOwner, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

describe('事業者間データ分離・権限', () => {
  it('事業者AはBのサービス/スタッフ/予約/顧客/リソースにアクセスできない', async () => {
    const A = await signupOwner(env.app);
    const B = await signupOwner(env.app);
    const a = await basicSetup(A.client, { resource: true });
    const b = await basicSetup(B.client, { resource: true });
    const bk = JSON.parse((await publicBooking(env.app, B.slug, { serviceId: b.serviceId, start: isoAt(futureDate(3), 10), customer: { name: 'B顧客', email: 'bcust@example.test' }, idempotencyKey: randomUUID() })).body);
    const bBooking = (await env.pool.query(`SELECT id, customer_id FROM bookings WHERE business_id = $1`, [B.businessId])).rows[0];
    void bk;
    const c = A.client;
    // reads
    expect((await c.get(`/api/admin/bookings/${bBooking.id}`)).statusCode).toBe(404);
    expect((await c.get(`/api/admin/customers/${bBooking.customer_id}`)).statusCode).toBe(404);
    expect((await c.get(`/api/admin/customers/${bBooking.customer_id}/export`)).statusCode).toBe(404);
    const list = await c.json('GET', '/api/admin/bookings');
    expect(list.total).toBe(0);
    const svcs = await c.json('GET', '/api/admin/services');
    expect(svcs.services.map((s: { id: string }) => s.id)).toEqual([a.serviceId]);
    // writes
    expect((await c.put(`/api/admin/services/${b.serviceId}`, { name: 'hack', durationMin: 30 })).statusCode).toBe(404);
    expect((await c.put(`/api/admin/staff/${b.staffIds[0]}`, { displayName: 'hack' })).statusCode).toBe(404);
    expect((await c.put(`/api/admin/resources/${b.resourceId}`, { name: 'hack' })).statusCode).toBe(404);
    expect((await c.post(`/api/admin/services/${b.serviceId}/archive`)).statusCode).toBe(404);
    expect((await c.post(`/api/admin/bookings/${bBooking.id}/cancel`, { by: 'business' })).statusCode).toBe(404);
    expect((await c.post(`/api/admin/bookings/${bBooking.id}/status`, { to: 'no_show' })).statusCode).toBe(404);
    expect((await c.post(`/api/admin/bookings/${bBooking.id}/reschedule`, { start: isoAt(futureDate(4), 10) })).statusCode).toBe(404);
    expect((await c.put(`/api/admin/customers/${bBooking.customer_id}`, { name: 'hack' })).statusCode).toBe(404);
    // cross-tenant references inside a payload
    expect((await c.post('/api/admin/services', { name: 'x', durationMin: 30, staffIds: [b.staffIds[0]] })).statusCode).toBe(404);
    expect((await c.post('/api/admin/services', { name: 'x', durationMin: 30, resourceIds: [b.resourceId] })).statusCode).toBe(404);
    expect((await c.post('/api/admin/bookings', { serviceId: b.serviceId, staffId: b.staffIds[0], start: isoAt(futureDate(5), 10), customer: { name: 'x' }, idempotencyKey: randomUUID() })).statusCode).toBe(409);
    expect((await c.post('/api/admin/bookings', { serviceId: a.serviceId, staffId: a.staffIds[0], start: isoAt(futureDate(5), 10), customerId: bBooking.customer_id, idempotencyKey: randomUUID() })).statusCode).toBe(404);
    expect((await c.post('/api/admin/blocks', { scope: 'staff', targetId: b.staffIds[0], start: isoAt(futureDate(5), 10), end: isoAt(futureDate(5), 11) })).statusCode).toBe(404);
    // B's data unchanged
    const still = (await env.pool.query(`SELECT status FROM bookings WHERE id = $1`, [bBooking.id])).rows[0];
    expect(still.status).toBe('confirmed');
    // public API of A cannot book B's service
    const cross = await publicBooking(env.app, A.slug, { serviceId: b.serviceId, start: isoAt(futureDate(3), 12), customer: { name: 'x', email: 'x@example.test' }, idempotencyKey: randomUUID() });
    expect(cross.statusCode).toBe(409);
  });

  it('未ログイン・CSRFトークンなしの変更操作は拒否', async () => {
    const A = await signupOwner(env.app);
    const anon = new Client(env.app);
    expect((await anon.get('/api/admin/bookings')).statusCode).toBe(401);
    const noCsrf = await env.app.inject({ method: 'POST', url: '/api/admin/services', headers: { cookie: A.client.cookie }, payload: { name: 'x', durationMin: 30 } });
    expect(noCsrf.statusCode).toBe(403);
    const wrongCsrf = await env.app.inject({ method: 'POST', url: '/api/admin/services', headers: { cookie: A.client.cookie, 'x-csrf-token': 'x'.repeat(32) }, payload: { name: 'x', durationMin: 30 } });
    expect(wrongCsrf.statusCode).toBe(403);
  });

  it('スタッフ権限：自分の予約のみ・設定変更不可・顧客閲覧は権限次第', async () => {
    const O = await signupOwner(env.app);
    const { serviceId, staffIds } = await basicSetup(O.client, { staffCount: 2 });
    const inv = await O.client.json('POST', '/api/admin/invites', { email: 'staff1@example.test', role: 'staff', staffId: staffIds[0], sendEmail: false });
    const token = inv.inviteUrl.split('#t=')[1];
    const s = new Client(env.app);
    const acc = await s.req('POST', '/api/auth/invite/accept', { token, name: 'スタッフ1', password: 'staff-password-1' });
    expect(acc.statusCode).toBe(200);
    // invite link is single-use
    expect((await new Client(env.app).req('POST', '/api/auth/invite/accept', { token, name: 'x', password: 'staff-password-1' })).statusCode).toBe(400);
    const me = await s.json('GET', '/api/auth/me');
    s.csrf = me.csrfToken;
    expect(me.role).toBe('staff');
    const date = futureDate(3);
    await publicBooking(env.app, O.slug, { serviceId, staffId: staffIds[0], start: isoAt(date, 10), customer: { name: '自分の客', email: 'mine@example.test' }, idempotencyKey: randomUUID() });
    const other = JSON.parse((await publicBooking(env.app, O.slug, { serviceId, staffId: staffIds[1], start: isoAt(date, 10), customer: { name: '他人の客', email: 'other@example.test' }, idempotencyKey: randomUUID() })).body);
    void other;
    const list = await s.json('GET', '/api/admin/bookings');
    expect(list.bookings.map((b: { customerName: string }) => b.customerName)).toEqual(['自分の客']);
    const otherId = (await env.pool.query(`SELECT b.id FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE c.name = '他人の客'`)).rows[0].id;
    expect((await s.get(`/api/admin/bookings/${otherId}`)).statusCode).toBe(403);
    expect((await s.post(`/api/admin/bookings/${otherId}/cancel`, { by: 'business' })).statusCode).toBe(403);
    expect((await s.put('/api/admin/settings', {})).statusCode).toBe(403);
    expect((await s.post('/api/admin/services', { name: 'x', durationMin: 30 })).statusCode).toBe(403);
    expect((await s.get('/api/admin/export/bookings.csv')).statusCode).toBe(403);
    expect((await s.get('/api/admin/backup')).statusCode).toBe(403);
    expect((await s.get('/api/admin/audit')).statusCode).toBe(403);
    // own block ok, others' block not
    expect((await s.post('/api/admin/blocks', { scope: 'staff', targetId: staffIds[0], start: isoAt(date, 15), end: isoAt(date, 16) })).statusCode).toBe(200);
    expect((await s.post('/api/admin/blocks', { scope: 'staff', targetId: staffIds[1], start: isoAt(date, 15), end: isoAt(date, 16) })).statusCode).toBe(403);
    expect((await s.post('/api/admin/blocks', { scope: 'business', targetId: null, start: isoAt(date, 15), end: isoAt(date, 16) })).statusCode).toBe(403);
    // revoke customer permission
    const members = await O.client.json('GET', '/api/admin/members');
    const staffUser = members.members.find((m: { role: string }) => m.role === 'staff');
    await O.client.json('PUT', `/api/admin/members/${staffUser.user_id}`, { staffId: staffIds[0], permissions: { viewAllBookings: false, manageBookings: false, viewCustomers: false, manageOwnBlocks: false } });
    expect((await s.get('/api/admin/customers')).statusCode).toBe(403);
    expect((await s.post('/api/admin/bookings', { serviceId, staffId: staffIds[0], start: isoAt(date, 13), customer: { name: 'x' }, idempotencyKey: randomUUID() })).statusCode).toBe(403);
    // removing the member kills the session
    await O.client.json('DELETE', `/api/admin/members/${staffUser.user_id}`);
    expect((await s.get('/api/admin/bookings')).statusCode).toBe(401);
  });

  it('ログイン失敗のロックとレート制限', async () => {
    const A = await signupOwner(env.app);
    const c = new Client(env.app);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await c.req('POST', '/api/auth/login', { email: A.email, password: 'wrong-password' })).statusCode);
    expect(codes.slice(0, 8).every((x) => x === 401)).toBe(true);
    expect(codes.slice(8).every((x) => x === 429)).toBe(true);
    const r = await new Client(env.app).req('POST', '/api/auth/login', { email: A.email, password: 'correct-horse-battery' });
    expect(r.statusCode).toBe(429);
  });

  it('SQLインジェクション風入力は値として扱われる', async () => {
    const A = await signupOwner(env.app);
    await basicSetup(A.client);
    const r = await A.client.get(`/api/admin/customers?q=${encodeURIComponent("'; DROP TABLE bookings; --")}`);
    expect(r.statusCode).toBe(200);
    const b = await A.client.get(`/api/admin/bookings?q=${encodeURIComponent("%' OR 1=1 --")}`);
    expect(JSON.parse(b.body).total).toBe(0);
    expect((await env.pool.query(`SELECT to_regclass('public.bookings') AS t`)).rows[0].t).toBe('bookings');
  });

  it('セキュリティヘッダ（CSP等）', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/api/health' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });
});

describe('出力の安全性', () => {
  it('CSV数式インジェクション対策とBOM', () => {
    expect(csvSafe('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`);
    expect(csvSafe('+81 90')).toBe(`'+81 90`);
    expect(csvSafe('-1')).toBe(`'-1`);
    expect(csvSafe('@SUM(A1)')).toBe(`'@SUM(A1)`);
    expect(csvSafe('山田')).toBe('山田');
    const csv = toCsv(['a', 'b'], [['=1+1', 'x,"y"']]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`'=1+1,"x,""y"""`);
  });

  it('CSVエクスポートでも数式が無害化される', async () => {
    const A = await signupOwner(env.app);
    const { serviceId } = await basicSetup(A.client);
    await publicBooking(env.app, A.slug, { serviceId, start: isoAt(futureDate(3), 10), customer: { name: '=cmd|calc!A1', email: 'csv@example.test' }, idempotencyKey: randomUUID() });
    const r = await A.client.get('/api/admin/export/customers.csv');
    expect(r.statusCode).toBe(200);
    expect(r.body.startsWith('﻿')).toBe(true);
    expect(r.body).toContain(`'=cmd|calc!A1`);
    const b = await A.client.get('/api/admin/export/bookings.csv');
    expect(b.body).toContain(`'=cmd|calc!A1`);
  });

  it('メールテンプレート変数は制御文字を除去（ヘッダインジェクション不可）、HTMLは生成しない', () => {
    expect(renderTemplate('こんにちは {{name}} 様', { name: 'x\r\nBcc: evil@example.com' })).toBe('こんにちは x  Bcc: evil@example.com 様');
    expect(renderTemplate('{{unknown}}', {})).toBe('');
  });

  it('ICSテキストのエスケープ', () => {
    expect(icsText('a;b,c\nDTSTART:1')).toBe('a\\;b\\,c\\nDTSTART:1');
  });
});
