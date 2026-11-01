import { expect, test, type Page } from '@playwright/test';

/** Uses the one-click demo accounts on the login page (seeded by `npm run db:seed`). */
async function loginAs(page: Page, who: 'asha' | 'admin') {
  await page.goto('/login');
  await page.getByRole('button', { name: who, exact: true }).click();
  await expect(page).toHaveURL(/\/trade/);
}

test('a trader buys BTC at market and it settles into the portfolio', async ({ page }) => {
  await loginAs(page, 'asha');
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

test('the Trade Coach shows a Skill Score, a weekly goal and graded report cards', async ({ page }) => {
  await loginAs(page, 'asha');
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

test('the Learn page previews an order against the live order book', async ({ page }) => {
  await loginAs(page, 'asha');
  await page.goto('/learn');
  await expect(page.getByLabel('Live order book')).toBeVisible();
  await expect(page.getByText(/^fill .* @ /).first()).toBeVisible(); // default market buy walks the live asks
  await expect(page.getByText(/If your stop is hit you lose about/)).toBeVisible();
});

test('competitions show a live leaderboard', async ({ page }) => {
  await loginAs(page, 'asha');
  await page.goto('/compete');
  await expect(page.getByRole('main').getByText('Diwali Trading Cup 2026').first()).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Asha/ })).toBeVisible();
});

test('admins see system health and the order pipeline', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.goto('/admin');
  await expect(page.getByText('Order pipeline per instrument')).toBeVisible();
  await expect(page.getByRole('row', { name: /^BTC-INR (Trading|Halted)/ })).toBeVisible();
  await page.getByRole('button', { name: 'Run checks' }).click();
  await expect(page.getByText('All invariants hold.')).toBeVisible();
});
