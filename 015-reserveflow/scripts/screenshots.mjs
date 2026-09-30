// Visual smoke check: captures key screens (mobile booking flow + desktop admin) of a running server.
// Usage: node scripts/screenshots.mjs <outDir> [baseUrl]
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2] ?? 'screenshots';
const base = process.argv[3] ?? 'http://127.0.0.1:8787';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const errors = [];

const m = await browser.newContext({ ...devices['iPhone 13'] });
const p = await m.newPage();
p.on('pageerror', (e) => errors.push('mobile: ' + e.message));
p.on('console', (c) => c.type() === 'error' && errors.push('mobile console: ' + c.text()));
await p.goto(base + '/book/sample-studio');
await p.getByText('60分個人レッスン').waitFor();
await p.screenshot({ path: `${out}/m1-services.png`, fullPage: true });
await p.getByText('60分個人レッスン').click();
await p.getByText('指名なし（おまかせ）').click();
await p.waitForSelector('button.day.avail');
await p.screenshot({ path: `${out}/m2-dates.png`, fullPage: true });
await p.locator('button.day.avail').first().click();
await p.waitForSelector('button.time-btn');
await p.screenshot({ path: `${out}/m3-times.png`, fullPage: true });

const d = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const a = await d.newPage();
a.on('pageerror', (e) => errors.push('desktop: ' + e.message));
a.on('console', (c) => c.type() === 'error' && errors.push('desktop console: ' + c.text()));
await a.goto(base + '/login');
await a.getByLabel('メールアドレス').fill('owner@sample.invalid');
await a.getByLabel('パスワード').fill('sample-password-123');
await a.getByRole('button', { name: 'ログイン' }).click();
await a.getByText('スタッフ別 今日の予定').waitFor();
await a.screenshot({ path: `${out}/d1-dashboard.png`, fullPage: true });
await a.goto(base + '/app/calendar?view=week');
await a.waitForSelector('.cal-grid');
await a.waitForTimeout(500);
await a.screenshot({ path: `${out}/d2-week.png` });
await a.goto(base + '/app/calendar?view=day');
await a.waitForSelector('.cal-grid');
await a.waitForTimeout(300);
await a.screenshot({ path: `${out}/d3-day.png` });

const am = await browser.newContext({ ...devices['iPhone 13'] });
const ap = await am.newPage();
ap.on('pageerror', (e) => errors.push('mobile-admin: ' + e.message));
await ap.goto(base + '/login');
await ap.getByLabel('メールアドレス').fill('owner@sample.invalid');
await ap.getByLabel('パスワード').fill('sample-password-123');
await ap.getByRole('button', { name: 'ログイン' }).click();
await ap.waitForURL(/\/app/);
await ap.goto(base + '/app/today');
await ap.waitForTimeout(800);
await ap.screenshot({ path: `${out}/m4-admin-today.png`, fullPage: true });
await ap.goto(base + '/app/calendar');
await ap.waitForTimeout(800);
await ap.screenshot({ path: `${out}/m5-admin-list.png`, fullPage: true });

console.log(errors.join('\n') || 'no errors');
await browser.close();
