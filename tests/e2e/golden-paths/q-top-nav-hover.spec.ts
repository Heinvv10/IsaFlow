/**
 * Golden path (q): the top nav opens every module menu on hover, and each daily
 * destination is one hover + one click from Home (master plan W1 PR N).
 *
 *  - T1 targets from /accounting: Invoices, Bank reconciliation, Pay Runs, VAT201, P&L.
 *  - One target again with the keyboard only (focus the menu button, Enter, Enter).
 *  - The right tab lights up on a sub-page, a query tab and an #anchor.
 *
 * The axe scan and the screenshots are in q2-top-nav-axe.spec.ts: this file must not import
 * @axe-core/playwright (directly or through the theme helpers), because verify-deploy runs it
 * against production with the a11y specs ignored and unloaded.
 *
 * Read-only: no data is created.
 */
import { test, expect, type Page } from '@playwright/test';

const NAV = 'nav:has([data-tour="nav-dashboard"])';

const T1: Array<{ tab: string; link: string; path: RegExp }> = [
  { tab: 'sales', link: 'Invoices', path: /\/accounting\/customer-invoices$/ },
  { tab: 'banking', link: 'Reconcile', path: /\/accounting\/bank-reconciliation$/ },
  { tab: 'payroll', link: 'Pay Runs', path: /\/payroll\/runs$/ },
  { tab: 'tax', link: 'VAT201', path: /\/accounting\/sars\/vat201$/ },
  { tab: 'reports', link: 'Profit & Loss', path: /\/accounting\/reports\/income-statement$/ },
];

const tabOf = (page: Page, id: string) => page.locator(`[data-tour="nav-${id}"]`);

for (const { tab, link, path } of T1) {
  test(`Home → ${link}: one hover, one click`, async ({ page }) => {
    await page.goto('/accounting');
    await tabOf(page, tab).hover();
    const target = tabOf(page, tab).getByRole('link', { name: link, exact: true });
    // VAT201 only exists for a VAT vendor. This spec also runs in the post-deploy check against production Demo,
    // where a missing link must never be a red run (a red run rolls the deploy back).
    if (link === 'VAT201') {
      await expect(tabOf(page, tab).getByRole('link', { name: 'EMP201', exact: true })).toBeVisible();
      test.skip((await target.count()) === 0, 'company is not VAT registered: no VAT201 link');
    }
    await target.click();
    await page.waitForURL(path, { timeout: 30_000 });
    await expect(tabOf(page, tab).locator('[aria-current="true"]').first()).toBeVisible();
  });
}

test('keyboard only: Pay Runs from the Payroll menu button', async ({ page }) => {
  await page.goto('/accounting');
  const button = tabOf(page, 'payroll').getByRole('button', { name: 'Payroll menu' });
  await button.focus();
  await page.keyboard.press('Space');
  await expect(tabOf(page, 'payroll').getByRole('link', { name: 'Pay Runs', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await expect(tabOf(page, 'payroll').getByRole('link', { name: 'Pay Runs', exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/payroll\/runs$/, { timeout: 30_000 });
});

test('ArrowDown on the Sales label opens the menu; Tab past the last entry closes it', async ({ page }) => {
  await page.goto('/accounting');
  const sales = tabOf(page, 'sales');
  await sales.getByRole('link', { name: 'Sales', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(sales.getByRole('link', { name: 'Invoices', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Tab');
  await expect(sales.getByRole('link', { name: 'Invoices', exact: true })).toHaveCount(0);
});

test('a click on the chevron right after hovering leaves the menu open', async ({ page }) => {
  await page.goto('/accounting');
  await tabOf(page, 'banking').hover();
  await tabOf(page, 'banking').getByRole('button', { name: 'Banking menu' }).click();
  await expect(tabOf(page, 'banking').getByRole('link', { name: 'Reconcile', exact: true })).toBeVisible();
});

test('the right tab lights up on a sub-page, a query tab and an #anchor', async ({ page }) => {
  const lit = (id: string) => tabOf(page, id).locator('[aria-current="true"]').first();
  await page.goto('/accounting/customer-invoices/new');
  await expect(lit('sales')).toBeVisible();
  await page.goto('/accounting/company-settings?tab=general#top');
  await expect(page.locator(`${NAV} [aria-current="true"]`)).toHaveCount(0);
  await page.goto('/accounting/reports/balance-sheet#totals');
  await expect(lit('reports')).toBeVisible();
  await page.goto('/accounting/chart-of-accounts');
  await expect(lit('library')).toBeVisible();
});

test('all ten tabs fit on one row at 1280 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/accounting');
  const tabs = page.locator(`${NAV} [data-tour^="nav-"]`);
  await expect(tabs).toHaveCount(10, { timeout: 30_000 });
  const boxes = await tabs.evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), right: r.right }; }));
  expect(new Set(boxes.map((b) => b.top)).size).toBe(1);
  expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(1280);
});
