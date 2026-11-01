import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests drive the real app: web → API → engine → settlement → coach.
 * Locally they reuse a running `npm run dev` (or start one) and use the installed Microsoft Edge, so no
 * browser download is needed; CI installs Playwright's Chromium.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:5200',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: process.env.CI ? 'chromium' : 'edge',
      use: process.env.CI
        ? { ...devices['Desktop Chrome'] }
        : { ...devices['Desktop Edge'], channel: 'msedge' },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5200',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
