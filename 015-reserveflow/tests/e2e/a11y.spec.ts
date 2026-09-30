import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { apiOwner, bookViaUi, loginUi, setupShop } from './helpers';

// Automated WCAG 2.1 A/AA checks (axe-core). Automated checks do not replace a manual review.
test('アクセシビリティ（axe: WCAG2.1 A/AA）主要画面', async ({ page }, info) => {
  test.skip(info.project.name === 'pixel-7-emulated', 'desktop + iPhone only');
  const o = await apiOwner('a11y');
  await setupShop(o);
  const results: Record<string, string[]> = {};
  const scan = async (name: string) => {
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    results[name] = r.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0]?.target.join(' ')}`);
  };
  await page.goto(`/book/${o.slug}`);
  await page.getByRole('button', { name: /60分レッスン/ }).waitFor();
  await scan('公開: メニュー');
  await page.getByRole('button', { name: /60分レッスン/ }).click();
  await page.locator('button.day.avail').first().waitFor();
  await scan('公開: 日付');
  await page.locator('button.day.avail').first().click();
  await page.locator('button.time-btn').first().click();
  await page.getByRole('button', { name: '次へ' }).click(); // trigger validation errors
  await scan('公開: お客様情報（エラー表示）');
  await bookViaUi(page, o.slug, { service: '60分レッスン', name: 'アクセシ 太郎', email: 'a11y@example.test', dayIndex: 1 });
  await scan('公開: 予約完了');
  await loginUi(page, o.email, o.password);
  await page.locator('main h1').first().waitFor();
  await scan('管理: ダッシュボード');
  for (const [path, name] of [['/app/today', '管理: 受付'], ['/app/calendar?view=week', '管理: カレンダー週'], ['/app/new', '管理: 新規予約'], ['/app/settings', '管理: 設定'], ['/app/services', '管理: サービス']]) {
    await page.goto(path);
    await page.waitForTimeout(700);
    await scan(name);
  }
  console.log(JSON.stringify(results, null, 2));
  const serious = Object.entries(results).flatMap(([k, v]) => v.filter((x) => /\((serious|critical)\)/.test(x)).map((x) => `${k}: ${x}`));
  expect(serious, serious.join('\n')).toEqual([]);
});
