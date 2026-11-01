/**
 * npm run screenshots — captures the main pages into docs/screenshots/ (needs `npm run dev` running and seeded data).
 * Uses the installed Microsoft Edge locally (set SCREENSHOT_CHANNEL=chromium to use Playwright's Chromium).
 */
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const base = process.env.WEB_URL ?? 'http://localhost:5200';
const out = path.resolve(import.meta.dirname, '../docs/screenshots');
const channel = process.env.SCREENSHOT_CHANNEL ?? 'msedge';

const browser = await chromium.launch(channel === 'chromium' ? {} : { channel });
const viewport = {
  width: Number(process.env.SCREENSHOT_WIDTH ?? 1440),
  height: Number(process.env.SCREENSHOT_HEIGHT ?? 900),
};
const ctx = await browser.newContext({ viewport, colorScheme: 'dark' });

async function login(page: Page, who: 'asha' | 'admin') {
  await page.goto(`${base}/login`);
  await page.getByRole('button', { name: who, exact: true }).click();
  await page.waitForURL(/\/trade/);
}
async function shot(page: Page, route: string, file: string, waitFor: string) {
  await page.goto(`${base}${route}`);
  await page.getByText(waitFor).first().waitFor();
  await page.waitForTimeout(1500); // let charts and animations settle
  await page.screenshot({ path: path.join(out, file) });
  console.log('saved', file);
}

const page = await ctx.newPage();
await login(page, 'asha');
if (process.env.SCREENSHOT_ONLY === 'coach') {
  await shot(page, '/coach', process.env.SCREENSHOT_FILE ?? 'coach.png', 'Ask your AI coach');
  await browser.close();
  process.exit(0);
}
if (process.env.SCREENSHOT_ONLY === 'trade') {
  await shot(page, '/trade/BTC-INR', process.env.SCREENSHOT_FILE ?? 'trade.png', 'Order book');
  await browser.close();
  process.exit(0);
}
await shot(page, '/trade', 'trade.png', 'Order book');
await shot(page, '/coach', 'coach.png', 'Trade report cards');
await shot(page, '/compete', 'compete.png', 'leaderboard');
await shot(page, '/learn', 'learn.png', 'What would happen right now');
await page.getByRole('button', { name: /log out/i }).click();
await login(page, 'admin');
await shot(page, '/admin', 'admin.png', 'Order pipeline per instrument');
await browser.close();
