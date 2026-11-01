import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Uses the one-click demo accounts on the login page (seeded by `npm run db:seed`).
 * Each role logs in ONCE and its page is shared by the tests below: the API allows 20 auth requests per minute per
 * IP, and refresh tokens rotate (a reused one logs the session out), so separate logins per test or a saved cookie
 * file would trip the app's own protections.
 */
async function loginAs(browser: Browser, who: 'asha' | 'admin'): Promise<Page> {
  const page = await browser.newPage({ baseURL: process.env.WEB_URL ?? 'http://localhost:5200' });
  await page.goto('/login');
  await page.getByRole('button', { name: who, exact: true }).click();
  await expect(page).toHaveURL(/\/trade/);
  return page;
}

test.describe.configure({ mode: 'serial' });
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await loginAs(browser, 'asha');
});
test.afterAll(async () => page?.close());

test('a trader buys BTC at market and it settles into the portfolio', async () => {
  await page.goto('/trade');
  const form = page.getByRole('form', { name: 'Order entry' });
  await expect(form.getByRole('button', { name: /^Buy BTC/ })).toBeVisible();

  await form.getByRole('radio', { name: 'Market' }).click();
  await form.locator('#qty').fill('0.0002');
  await form.getByRole('button', { name: /^Buy BTC/ }).click();

  const dialog = page.getByRole('dialog', { name: /Confirm buy order/ });
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Buy order sent')).toBeVisible();

  // matched by the engine, settled in Postgres, pushed back over the websocket
  await page.getByRole('link', { name: 'Portfolio' }).first().click();
  await expect(page.getByText('Equity', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText('BTC').first()).toBeVisible();
});

test('the Trade Coach shows a Skill Score, a weekly goal and graded report cards', async () => {
  await page.goto('/coach');
  await expect(page.getByRole('heading', { name: 'Trade Coach' })).toBeVisible();
  await expect(page.getByLabel(/Skill score \d+/)).toBeVisible();
  await expect(page.getByText('This week’s goal')).toBeVisible();
  const firstCard = page
    .getByRole('heading', { name: 'Trade report cards' })
    .locator('..')
    .getByRole('listitem')
    .first();
  await expect(firstCard.getByLabel(/Grade [A-F]/)).toBeVisible();
  // expanding a card shows the reasoning
  await firstCard.getByRole('button').first().click();
  await expect(firstCard.getByText('Process score')).toBeVisible();
});

test('the Learn page previews an order against the live order book', async () => {
  await page.goto('/learn');
  await expect(page.getByLabel('Live order book')).toBeVisible();
  await expect(page.getByText(/^fill .* @ /).first()).toBeVisible(); // default market buy walks the live asks
  await expect(page.getByText(/If your stop is hit you lose about/)).toBeVisible();
});

// TODO(me) [Phase 8 task, ~25 min]: add an e2e test for the Learn page's risk calculator: change "Stop-loss price"
//   from 98 to 95 and assert the suggested position gets smaller (and the loss stays at the chosen 1%).
//   Run it with `npm run e2e -- -g "risk calculator"`.
test('competitions show a live leaderboard', async () => {
  await page.goto('/compete');
  await expect(page.getByRole('main').getByText('Diwali Trading Cup 2026').first()).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Asha/ })).toBeVisible();
});

test('admins see system health and the order pipeline', async ({ browser }) => {
  const admin = await loginAs(browser, 'admin');
  await admin.goto('/admin');
  await expect(admin.getByText('Order pipeline per instrument')).toBeVisible();
  await expect(admin.getByRole('row', { name: /^BTC-INR (Trading|Halted)/ })).toBeVisible();
  await admin.getByRole('button', { name: 'Run checks' }).click();
  // the ledger check scans every trade and order (~4 s on a well-used dev database), so allow it more time
  await expect(admin.getByText('All invariants hold.')).toBeVisible({ timeout: 45_000 });
  await admin.close();
});
