/**
 * Golden path (n): the Banking top-nav dropdown offers the daily banking set
 * and each link lands on its page.
 *
 * Regression for master-plan D6: the dropdown showed only "Banking Settings"
 * (operational items sat behind hover-only section rows). Read-only: no data
 * is created.
 */
import { test, expect } from '@playwright/test';

const LINKS: Array<{ name: string; path: RegExp }> = [
  { name: 'Bank Transactions', path: /\/accounting\/bank-transactions$/ },
  { name: 'Bank Reconciliation', path: /\/accounting\/bank-reconciliation$/ },
  { name: 'Transfers', path: /\/accounting\/bank-transfers$/ },
];

for (const { name, path } of LINKS) {
  test(`Banking top-nav → ${name}`, async ({ page }) => {
    await page.goto('/accounting');
    const banking = page.locator('[data-tour="nav-banking"]');
    await banking.getByRole('button', { name: /banking/i }).click();
    await banking.getByRole('link', { name, exact: true }).click();
    await page.waitForURL(path, { timeout: 30_000 });
    await expect(page).toHaveURL(path);
  });
}
