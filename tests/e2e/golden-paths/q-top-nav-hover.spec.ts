/**
 * Golden path (q): the top nav opens every module menu on hover, and each daily
 * destination is one hover + one click from Home (master plan W1 PR N).
 *
 *  - T1 targets from /accounting: Invoices, Bank reconciliation, Pay Runs, VAT201, P&L.
 *  - One target again with the keyboard only (focus the menu button, Enter, Enter).
 *  - The right tab lights up on a sub-page, a query tab and an #anchor.
 *  - axe: no serious violation in the nav bar with a menu and a sub-panel open ('shell:top-nav-menu').
 *  - EVIDENCE=1 saves screenshots of the open menu in both themes to docs/evidence.
 *
 * Read-only: no data is created.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { expectNoSeriousA11yViolations } from './helpers/axe';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const NAV = 'nav:has([data-tour="nav-dashboard"])';
const EVIDENCE_DIR = 'docs/evidence/master-plan/wave1/nav';

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
    await tabOf(page, tab).getByRole('link', { name: link, exact: true }).click();
    await page.waitForURL(path, { timeout: 30_000 });
    await expect(tabOf(page, tab).locator('[aria-current="true"]').first()).toBeVisible();
  });
}

test('keyboard only: Pay Runs from the Payroll menu button', async ({ page }) => {
  await page.goto('/accounting');
  const button = tabOf(page, 'payroll').getByRole('button', { name: 'Payroll menu' });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(tabOf(page, 'payroll').getByRole('link', { name: 'Pay Runs', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await expect(tabOf(page, 'payroll').getByRole('link', { name: 'Pay Runs', exact: true })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/payroll\/runs$/, { timeout: 30_000 });
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

for (const theme of THEMES) {
  test(`${theme} theme: menu and sub-panel are axe-clean`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedTheme(page, theme);
    await page.goto('/accounting');
    await settle(page);
    await tabOf(page, 'sales').hover();
    await tabOf(page, 'sales').getByRole('button', { name: 'Customers' }).hover();
    await expect(tabOf(page, 'sales').getByRole('link', { name: 'Debtors Manager' })).toBeVisible();
    if (process.env.EVIDENCE === '1') {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${EVIDENCE_DIR}/top-nav-sales-${theme}.png`, clip: { x: 0, y: 0, width: 1280, height: 520 } });
    }
    await expectNoSeriousA11yViolations(page, { include: [NAV], key: `shell:top-nav-menu`, includeShell: true });
  });
}
