import { defineConfig, devices } from '@playwright/test';

const PORT = 8790;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'postgres://reserveflow:reserveflow@127.0.0.1:5432/reserveflow_e2e',
      APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
      PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
      ALLOW_SIGNUP: 'true',
      RUN_WORKER: 'true',
      WORKER_INTERVAL_MS: '2000',
      EMAIL_DRIVER: 'log',
      RATE_LIMIT_SCALE: '100',
    },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    // NOTE: WebKit is not installed in this environment; iPhone/Android are emulated with Chromium (viewport, touch, UA).
    { name: 'iphone-13-emulated', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'pixel-7-emulated', use: { ...devices['Pixel 7'] } },
  ],
});
