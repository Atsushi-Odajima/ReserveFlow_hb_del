import { expect, test } from '@playwright/test';
import { apiOwner, bookViaUi, call, loginUi, setupShop } from './helpers';

// E2E-6: customer books on a phone; the owner handles reception on a phone (PWA-sized viewport); PC sees the history.
test('E2E-6 スマホで顧客予約完了 → スマホ管理で受付→完了 → PCで履歴反映', async ({ page, browser }, info) => {
  test.skip(info.project.name === 'desktop-chromium', 'mobile projects only');
  const o = await apiOwner(`e2e6${info.project.name.slice(0, 4)}`);
  const { serviceId, staffId } = await setupShop(o, { minNoticeMin: 0 });
  // a booking starting in ~5 minutes so it appears in "today" (forced to allow any hour of the day the test runs)
  const soon = new Date(Date.now() + 5 * 60_000);
  soon.setSeconds(0, 0);
  await call(o, 'POST', '/api/admin/bookings', { serviceId, staffId, start: soon.toISOString(), customer: { name: '当日 客', phone: '090-0000-0000' }, source: 'walk_in', force: true, forcedReason: 'E2E当日', idempotencyKey: crypto.randomUUID() });

  // customer: full booking on a phone
  const { ref } = await bookViaUi(page, o.slug, { service: '60分レッスン', name: 'スマホ 花子', email: 'sp@example.test', dayIndex: 1, timeIndex: 2 });
  expect(ref).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // tap targets on the booking page are at least 44px tall
  await page.goto(`/book/${o.slug}`);
  const box = await page.getByRole('button', { name: /60分レッスン/ }).boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  // no horizontal scrolling on the phone
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // owner on the phone: reception → check-in → complete
  await loginUi(page, o.email, o.password);
  await expect(page.locator('.bottom-nav')).toBeVisible();
  await page.locator('.bottom-nav').getByRole('link', { name: /受付/ }).click();
  await expect(page.getByRole('heading', { name: /受付/ })).toBeVisible();
  const card = page.locator('.card', { hasText: '当日 客 様' });
  await card.getByRole('button', { name: '来店・開始' }).click();
  await expect(card.locator('.pill')).toContainText('来店/開始済み');
  await card.getByRole('button', { name: '完了' }).click();
  await expect(card.locator('.pill')).toContainText('完了');

  // PC: history reflects the reception
  const pc = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pp = await pc.newPage();
  await loginUi(pp, o.email, o.password);
  await pp.goto('/app/bookings?status=completed&from=2000-01-01&to=2100-01-01');
  await pp.getByRole('link', { name: /\d+\/\d+/ }).first().click();
  await expect(pp.getByRole('heading', { name: '当日 客 様' })).toBeVisible();
  const rows = pp.locator('table').filter({ hasText: '状態の履歴' }).or(pp.locator('.card', { hasText: '状態の履歴' }).locator('table'));
  await expect(rows.first()).toContainText('予約確定 → 来店/開始済み');
  await expect(rows.first()).toContainText('来店/開始済み → 完了');
  await pc.close();
});

test('PWA: manifest と service worker が配信される', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone-13-emulated', 'once');
  const m = await (await page.request.get('/manifest.webmanifest')).json();
  expect(m.display).toBe('standalone');
  expect(m.icons.some((i: any) => i.sizes === '512x512')).toBe(true);
  const sw = await page.request.get('/sw.js');
  expect(sw.status()).toBe(200);
  await page.goto('/login');
  const registered = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return !!r.active;
  });
  expect(registered).toBe(true);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
});
