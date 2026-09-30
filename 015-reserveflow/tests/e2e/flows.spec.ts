import { expect, test, type Browser } from '@playwright/test';
import { apiOwner, bookViaUi, call, loginUi, setupShop, uniq } from './helpers';

const desktopOnly = (name: string) => test.skip(name !== 'desktop-chromium', 'desktop project only');

test('E2E-1 事業者設定→サービス→スタッフ→Room→公開→顧客予約→通知→管理→来店→完了→次回予約', async ({ page, browser }, info) => {
  desktopOnly(info.project.name);
  const slug = uniq('e2e1');
  const email = `${slug}@example.test`;
  // owner signs up and configures everything through the UI
  await page.goto('/signup');
  await page.getByLabel('お名前').fill('山田 オーナー');
  await page.getByLabel(/メールアドレス/).fill(email);
  await page.getByLabel('パスワード').fill('owner-password-1');
  await page.getByLabel(/事業者名/).fill('E2E サロン');
  await page.getByLabel(/URL名/).fill(slug);
  await page.getByLabel('タイムゾーン').fill('Asia/Tokyo');
  await page.getByRole('button', { name: '登録する' }).click();
  await expect(page.getByRole('heading', { name: '事業者設定・公開' })).toBeVisible();
  await page.getByLabel(/予約ページを公開する/).check();
  await page.getByLabel(/メール（予約ページ・メールに表示）/).fill('salon@example.test');
  await page.getByLabel('最短受付時間（何分前まで予約可）').selectOption('0');
  await page.getByRole('button', { name: '設定を保存' }).click();
  await expect(page.getByText('保存しました')).toBeVisible();

  // hours: add Sunday and Wednesday..., default is Mon-Sat 10-18; keep defaults
  await page.goto('/app/resources');
  await page.getByRole('button', { name: '＋ リソースを追加' }).click();
  await page.getByLabel('名称').fill('Room A');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: 'Room A' })).toBeVisible();

  await page.goto('/app/services');
  await page.getByRole('button', { name: '＋ サービスを追加' }).click();
  await page.getByLabel('名称').fill('60分カット');
  await page.getByLabel('所要時間（分）').fill('60');
  await page.getByLabel('準備時間（前・分）').fill('15');
  await page.getByLabel('片付け時間（後・分）').fill('15');
  await page.getByRole('checkbox', { name: 'Room A' }).check();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: '60分カット' })).toBeVisible();

  await page.goto('/app/staff');
  await page.getByRole('button', { name: '＋ スタッフを追加' }).click();
  await page.getByLabel('表示名（予約ページに表示）').fill('Aki');
  await page.getByRole('checkbox', { name: '60分カット' }).check();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('button', { name: 'Aki' })).toBeVisible();

  // customer books on a phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ja-JP' });
  const cp = await phone.newPage();
  const { chosen, ref } = await bookViaUi(cp, slug, { service: '60分カット', name: '佐藤 花子', email: 'hanako.e2e@example.test' });
  expect(chosen).toMatch(/^\d\d:\d\d$/);
  // 10:00 cannot be first: Aki uses business hours, so the 15-min prep must fit inside them → first slot 10:15? grid is 30 min → 10:30
  expect(chosen).not.toBe('10:00');
  await cp.getByRole('link', { name: '予約を確認・変更する' }).click();
  await expect(cp.getByRole('heading', { name: 'ご予約内容' })).toBeVisible();
  await expect(cp.getByText(ref!)).toBeVisible();
  await phone.close();

  // notification recorded (log driver) and processed by the worker
  await page.goto('/app/notifications');
  await expect(page.getByText('予約確定（お客様）').first()).toBeVisible();
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('cell', { name: /送信済み/ }).first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });

  // admin sees it, checks in, completes, creates the next booking
  await page.goto('/app/bookings?status=confirmed');
  await page.getByRole('link', { name: /\d+\/\d+.*\d\d:\d\d/ }).first().click();
  await expect(page.getByRole('heading', { name: '佐藤 花子 様' })).toBeVisible();
  await page.getByRole('button', { name: '来店・開始' }).click();
  await expect(page.getByText('来店/開始済み').first()).toBeVisible();
  await page.getByRole('button', { name: '完了' }).click();
  await expect(page.locator('.pill', { hasText: '完了' })).toBeVisible();
  await page.getByRole('link', { name: '次回予約' }).click();
  await expect(page.getByRole('heading', { name: '新規予約・空き検索' })).toBeVisible();
  await page.getByLabel('（まで）').first().fill(new Date(Date.now() + 20 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }));
  await page.getByRole('button', { name: '空きを検索' }).click();
  await page.locator('button.time-btn').nth(5).click();
  await expect(page.getByText(/顧客: 佐藤 花子/)).toBeVisible();
  await page.getByRole('button', { name: '予約を確定する' }).click();
  await expect(page.getByRole('heading', { name: '佐藤 花子 様' })).toBeVisible();
  await page.getByRole('link', { name: /佐藤 花子（No\./ }).click();
  await expect(page.getByRole('row', { name: /予約数/ })).toContainText('2');
  await expect(page.getByRole('row', { name: /^完了/ })).toContainText('1');
});

async function twoCustomers(browser: Browser) {
  const a = await browser.newContext({ locale: 'ja-JP' });
  const b = await browser.newContext({ locale: 'ja-JP' });
  return { a: await a.newPage(), b: await b.newPage(), close: async () => { await a.close(); await b.close(); } };
}

test('E2E-2 顧客A/Bが同じ枠を同時に選択 → A成功 → B失敗 → 別候補で予約', async ({ browser }, info) => {
  desktopOnly(info.project.name);
  const o = await apiOwner('e2e2');
  await setupShop(o);
  const { a, b, close } = await twoCustomers(browser);
  // both reach the confirmation screen for the same slot
  const ra = await bookViaUi(a, o.slug, { service: '60分レッスン', name: '客A', email: 'a@example.test', dayIndex: 1, time: '11:00', submit: false });
  const rb = await bookViaUi(b, o.slug, { service: '60分レッスン', name: '客B', email: 'b@example.test', dayIndex: 1, time: '11:00', submit: false });
  expect(ra.chosen).toBe(rb.chosen);
  await a.getByRole('button', { name: '予約を確定する' }).click();
  await expect(a.getByRole('heading', { name: 'ご予約が確定しました' })).toBeVisible();
  await b.getByRole('button', { name: '予約を確定する' }).click();
  await expect(b.getByRole('alert').filter({ hasText: '別の時間を選んでください' })).toBeVisible();
  await expect(b.getByRole('heading', { name: 'ほかの空き時間' })).toBeVisible();
  const alt = b.locator('.card button.time-btn').first();
  await expect(alt).not.toContainText('11:00');
  await alt.click();
  await b.getByRole('button', { name: '予約を確定する' }).click();
  await expect(b.getByRole('heading', { name: 'ご予約が確定しました' })).toBeVisible();
  const list = await call(o, 'GET', '/api/admin/bookings?status=confirmed');
  expect(list.total).toBe(2);
  expect(new Set(list.bookings.map((x: any) => x.start)).size).toBe(2);
  await close();
});

test('E2E-3 予約→管理リンク→日時変更→新枠確保→旧枠解放→変更通知', async ({ page }, info) => {
  desktopOnly(info.project.name);
  const o = await apiOwner('e2e3');
  const { serviceId } = await setupShop(o);
  const r = await bookViaUi(page, o.slug, { service: '60分レッスン', name: '変更 太郎', email: 'change@example.test', dayIndex: 2, time: '14:00' });
  await page.getByRole('link', { name: '予約を確認・変更する' }).click();
  await expect(page).toHaveURL(/\/manage$/); // token removed from the address bar
  await page.getByRole('button', { name: '日時を変更する' }).click();
  await page.locator('button.time-btn', { hasText: '16:00' }).first().click();
  await page.getByRole('button', { name: /16:00 に変更する/ }).click();
  await expect(page.getByText('日時を変更しました')).toBeVisible();
  await expect(page.getByText(/16:00〜17:00/)).toBeVisible();
  const all = await call(o, 'GET', '/api/admin/bookings');
  const statuses = all.bookings.map((b: any) => b.status).sort();
  expect(statuses).toEqual(['confirmed', 'rescheduled']);
  const moved = all.bookings.find((b: any) => b.status === 'confirmed');
  const d = await call(o, 'GET', `/api/admin/bookings/${moved.id}`);
  expect(d.notifications.map((n: any) => n.kind)).toContain('booking_changed');
  // old 14:00 is free again
  const date = new Date(moved.start).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const slots = await (await o.api.get(`/api/public/${o.slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}`)).json();
  const times = slots.dates[date].map((s: any) => new Date(s.start).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }));
  expect(times).toContain('14:00');
  expect(times).not.toContain('16:00');
  void r;
});

test('E2E-4 予約→顧客キャンセル→枠再開放→待機候補表示', async ({ page, browser }, info) => {
  desktopOnly(info.project.name);
  const o = await apiOwner('e2e4');
  await setupShop(o);
  await bookViaUi(page, o.slug, { service: '60分レッスン', name: 'キャンセル 花子', email: 'cxl@example.test', dayIndex: 3, time: '15:00' });
  const manageHref = await page.getByRole('link', { name: '予約を確認・変更する' }).getAttribute('href');
  // someone else joins the waitlist for that day
  const w = await browser.newContext({ locale: 'ja-JP' });
  const wp = await w.newPage();
  await wp.goto(`/book/${o.slug}`);
  await wp.getByRole('button', { name: /60分レッスン/ }).click();
  await wp.locator('button.day.avail').nth(3).click();
  await wp.getByRole('button', { name: /空き待ち登録/ }).click();
  await wp.getByLabel('希望の時間帯').selectOption('afternoon');
  await wp.getByLabel('お名前').fill('待機 次郎');
  await wp.getByLabel('メールアドレス').fill('wait@example.test');
  await wp.getByRole('button', { name: '空き待ちを登録' }).click();
  await expect(wp.getByText('予約の確定・保証ではありません')).toBeVisible();
  await w.close();
  // customer cancels via manage link
  await page.goto(manageHref!);
  await page.getByRole('button', { name: 'キャンセルする' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'キャンセルする' }).click();
  await expect(page.getByText('キャンセルを承りました')).toBeVisible();
  await expect(page.locator('.pill', { hasText: '顧客キャンセル' })).toBeVisible();
  // owner sees the waitlist candidate
  await loginUi(page, o.email, o.password);
  await page.goto('/app/waitlist');
  await expect(page.getByText('待機 次郎 様')).toBeVisible();
  await expect(page.getByText(/★ 空きあり/)).toBeVisible();
  await page.getByRole('button', { name: '現在の空き候補' }).click();
  await expect(page.getByRole('dialog').getByText(/15:00〜16:00/)).toBeVisible();
});

test('E2E-5 6名ワークショップ→5名予約済み→1名成功→満席', async ({ page }, info) => {
  desktopOnly(info.project.name);
  const o = await apiOwner('e2e5');
  const { serviceId, staffId } = await setupShop(o, { capacity: 6, mode: 'sessions', name: '6名ワークショップ' });
  const date = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const occ = await call(o, 'POST', '/api/admin/occurrences', { serviceId, staffId, start: new Date(`${date}T13:00:00+09:00`).toISOString() });
  for (const [i, n] of [[1, 3], [2, 2]] as const)
    await o.api.post(`/api/public/${o.slug}/bookings`, { data: { serviceId, occurrenceId: occ.id, partySize: n, customer: { name: `参加者${i}`, email: `p${i}@example.test` }, idempotencyKey: crypto.randomUUID(), elapsedMs: 5000 } });
  await page.goto(`/book/${o.slug}`);
  await page.getByRole('button', { name: /6名ワークショップ/ }).click();
  await page.locator('button.day.avail').first().click();
  await expect(page.locator('button.time-btn')).toContainText('残り1名');
  // 2 people are not offered
  await page.getByRole('button', { name: '日付を選び直す' }).click();
  await page.getByLabel('人数').selectOption('2');
  await expect(page.locator('button.day.avail')).toHaveCount(0);
  await page.getByLabel('人数').selectOption('1');
  await page.locator('button.day.avail').first().click();
  await page.locator('button.time-btn').first().click();
  await page.getByLabel(/お名前/).fill('最後の1名');
  await page.getByLabel(/メールアドレス/).fill('last@example.test');
  await page.getByRole('button', { name: '次へ' }).click();
  await page.waitForTimeout(2600);
  await page.getByRole('button', { name: '予約を確定する' }).click();
  await expect(page.getByRole('heading', { name: 'ご予約が確定しました' })).toBeVisible();
  const slots = await (await o.api.get(`/api/public/${o.slug}/slots?serviceId=${serviceId}&from=${date}&to=${date}`)).json();
  expect(slots.dates[date]).toBeUndefined();
});

test('E2E-7 バックアップ→空環境へ復元→サービス/スタッフ/営業時間/予約/顧客/履歴が一致', async ({ page }, info) => {
  desktopOnly(info.project.name);
  const src = await apiOwner('e2e7src');
  const { serviceId } = await setupShop(src);
  await o_book(src, serviceId, 2, '11:00', '復元 一郎');
  await o_book(src, serviceId, 2, '13:00', '復元 二郎');
  await loginUi(page, src.email, src.password);
  await page.goto('/app/data');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'バックアップをダウンロード' }).click()]);
  const file = await dl.path();
  const dst = await apiOwner('e2e7dst');
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await page.waitForURL(/\/login$/);
  await loginUi(page, dst.email, dst.password);
  await page.goto('/app/data');
  await page.getByLabel('バックアップファイルを選択').setInputFiles(file!);
  await expect(page.getByText(/検証OK/)).toBeVisible();
  await page.getByRole('button', { name: 'この内容で復元する' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '復元する' }).click();
  await expect(page.getByText(/復元しました（予約 2 件）/)).toBeVisible();
  const [a, b] = [await call(src, 'GET', '/api/admin/bookings'), await call(dst, 'GET', '/api/admin/bookings')];
  const strip = (l: any[]) => l.map((x) => [x.start, x.customerName, x.serviceName, x.staffName, x.status, x.refCode]).sort();
  expect(strip(b.bookings)).toEqual(strip(a.bookings));
  const [sa, sb] = [await call(src, 'GET', '/api/admin/services'), await call(dst, 'GET', '/api/admin/services')];
  expect(sb.services.map((s: any) => [s.name, s.durationMin])).toEqual(sa.services.map((s: any) => [s.name, s.durationMin]));
  expect((await call(dst, 'GET', '/api/admin/hours')).hours).toEqual((await call(src, 'GET', '/api/admin/hours')).hours);
  expect((await call(dst, 'GET', '/api/admin/staff')).staff.map((s: any) => s.displayName)).toEqual(['Aki']);
  expect((await call(dst, 'GET', '/api/admin/customers')).total).toBe(2);
  const detail = await call(dst, 'GET', `/api/admin/bookings/${b.bookings[0].id}`);
  expect(detail.history.length).toBeGreaterThan(0);
});

async function o_book(o: Awaited<ReturnType<typeof apiOwner>>, serviceId: string, days: number, hhmm: string, name: string) {
  const date = new Date(Date.now() + days * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const r = await o.api.post(`/api/public/${o.slug}/bookings`, { data: { serviceId, start: new Date(`${date}T${hhmm}:00+09:00`).toISOString(), customer: { name, email: `${encodeURIComponent(name).slice(0, 10)}@example.test`.replace(/%/g, '') }, idempotencyKey: crypto.randomUUID(), elapsedMs: 5000 } });
  expect(r.status(), await r.text()).toBe(200);
}
