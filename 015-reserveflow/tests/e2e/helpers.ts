import { expect, request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';

export const BASE = 'http://127.0.0.1:8790';

export function uniq(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

export interface Owner {
  api: APIRequestContext;
  csrf: string;
  slug: string;
  email: string;
  password: string;
}

export async function apiOwner(slugPrefix = 'e2e'): Promise<Owner> {
  const api = await pwRequest.newContext({ baseURL: BASE });
  const slug = uniq(slugPrefix);
  const email = `${slug}@example.test`;
  const password = 'e2e-password-123';
  const r = await api.post('/api/auth/signup', { data: { email, password, name: 'E2E Owner', businessName: `E2E ${slug}`, slug, timezone: 'Asia/Tokyo' } });
  expect(r.status(), await r.text()).toBe(200);
  const me = await (await api.get('/api/auth/me')).json();
  return { api, csrf: me.csrfToken, slug, email, password };
}

export async function call(o: Owner, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, data?: unknown) {
  const r = await o.api.fetch(url, { method, data, headers: { 'x-csrf-token': o.csrf } });
  const text = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Open all week 10-18, publish, 60-min service with one staff (+ optional room). */
export async function setupShop(o: Owner, opts: { capacity?: number; mode?: 'slots' | 'sessions'; minNoticeMin?: number; name?: string } = {}) {
  const s = await call(o, 'GET', '/api/admin/settings');
  await call(o, 'PUT', '/api/admin/settings', { ...s, published: true, minNoticeMin: opts.minNoticeMin ?? 0, email: 'shop@example.test', cancelDeadlineMin: 60, changeDeadlineMin: 60 });
  await call(o, 'PUT', '/api/admin/hours', { hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 600, endMin: 1080 })) });
  const room = await call(o, 'POST', '/api/admin/resources', { name: 'Room A', quantity: 1 });
  const svc = await call(o, 'POST', '/api/admin/services', {
    name: opts.name ?? '60分レッスン',
    durationMin: 60,
    capacity: opts.capacity ?? 1,
    maxPartySize: opts.capacity ?? 1,
    bookingMode: opts.mode ?? 'slots',
    resourceIds: [room.id],
  });
  const staff = await call(o, 'POST', '/api/admin/staff', { displayName: 'Aki', serviceIds: [svc.id] });
  return { serviceId: svc.id as string, staffId: staff.id as string, roomId: room.id as string };
}

export function tomorrowJst(days = 1): string {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** Customer flow on the public page. Picks the n-th available day and the m-th time unless a time label is given. */
export async function bookViaUi(page: Page, slug: string, o: { service: string; name: string; email: string; dayIndex?: number; time?: string; timeIndex?: number; submit?: boolean }) {
  await page.goto(`/book/${slug}`);
  await page.getByRole('button', { name: new RegExp(o.service) }).click();
  const staffStep = page.getByRole('button', { name: /指名なし/ });
  if (await staffStep.isVisible().catch(() => false)) await staffStep.click();
  await page.locator('button.day.avail').first().waitFor();
  await page.locator('button.day.avail').nth(o.dayIndex ?? 0).click();
  await page.locator('button.time-btn').first().waitFor();
  const timeBtn = o.time ? page.locator('button.time-btn', { hasText: o.time }).first() : page.locator('button.time-btn').nth(o.timeIndex ?? 0);
  const chosen = (await timeBtn.innerText()).split('\n')[0].trim();
  await timeBtn.click();
  await page.getByLabel(/お名前/).fill(o.name);
  await page.getByLabel(/メールアドレス/).fill(o.email);
  await page.getByRole('button', { name: '次へ' }).click();
  await expect(page.getByRole('heading', { name: '予約内容の確認' })).toBeVisible();
  await page.waitForTimeout(2600); // real users take time; the server rejects sub-2.5s submissions as bots
  if (o.submit === false) return { chosen, ref: null };
  await page.getByRole('button', { name: '予約を確定する' }).click();
  await expect(page.getByRole('heading', { name: 'ご予約が確定しました' })).toBeVisible();
  const ref = (await page.locator('dd').first().innerText()).trim();
  return { chosen, ref };
}

export async function loginUi(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスワード').fill(password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForURL(/\/app/);
}
