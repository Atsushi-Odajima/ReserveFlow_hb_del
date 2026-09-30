// Renders the app icon SVG into PNG sizes using the pre-installed Chromium (Playwright).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const svg = (maskable) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${maskable ? 0 : 96}" fill="#2f6f5e"/>
  <g transform="translate(${maskable ? 106 : 86},${maskable ? 106 : 86}) scale(${maskable ? 0.59 : 0.66})">
    <rect x="20" y="70" width="472" height="400" rx="48" fill="#ffffff"/>
    <rect x="20" y="70" width="472" height="110" rx="48" fill="#cfe6de"/>
    <rect x="20" y="130" width="472" height="50" fill="#cfe6de"/>
    <rect x="120" y="20" width="44" height="110" rx="22" fill="#ffffff"/>
    <rect x="348" y="20" width="44" height="110" rx="22" fill="#ffffff"/>
    <path d="M150 320 l70 70 l150 -150" fill="none" stroke="#2f6f5e" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

mkdirSync('public/icons', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(maskable).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `public/icons/${name}`, omitBackground: !maskable, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', name);
}
await browser.close();
