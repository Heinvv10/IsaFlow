import { test, expect } from '@playwright/test';

/**
 * IsaFlow Navigation Tests
 * Verifies all nav tabs render, dropdowns open, and linked pages load (HTTP 200).
 */

// All routes referenced in accountingNavConfig.ts
const ALL_NAV_ROUTES = [
  // Dashboard
  '/accounting',

  // Customers
  '/accounting/customers',
  '/accounting/customers/new',
  '/accounting/customer-categories',
  '/accounting/customer-quotes',
  '/accounting/customer-invoices',
  '/accounting/recurring-invoices',
  '/accounting/customer-payments',
  '/accounting/credit-notes',
  '/accounting/write-offs',
  '/accounting/customer-allocations',
  '/accounting/adjustments?type=customer',
  '/accounting/reports/sales-by-customer',
  '/accounting/ar-aging',
  '/accounting/customer-statements',
  '/accounting/reports/unallocated-receipts',
  '/accounting/statement-run',
  '/accounting/dunning',
  '/accounting/opening-balances',
  '/accounting/debtors-manager',

  // Suppliers
  '/accounting/suppliers',
  '/accounting/suppliers/new',
  '/accounting/supplier-categories',
  '/accounting/supplier-invoices',
  '/accounting/supplier-returns',
  '/accounting/supplier-payments',
  '/accounting/batch-payments',
  '/accounting/supplier-allocations',
  '/accounting/adjustments?type=supplier',
  '/accounting/reports/purchases-by-supplier',
  '/accounting/ap-aging',
  '/accounting/supplier-statements',
  '/accounting/reports/unallocated-payments',

  // Items
  '/accounting/item-adjustments',
  '/accounting/item-pricing',
  '/accounting/item-opening-balances',
  '/accounting/reports/item-listing',
  '/accounting/reports/sales-by-item',
  '/accounting/reports/purchases-by-item',
  '/accounting/reports/item-movement',
  '/accounting/reports/item-valuation',
  '/accounting/reports/item-quantities',

  // Banking
  '/accounting/bank-accounts',
  '/accounting/bank-transactions',
  '/accounting/bank-reconciliation/import',
  '/accounting/bank-reconciliation',
  '/accounting/bank-transfers',
  '/accounting/bank-reconciliation/rules',

  // Accounts
  '/accounting/chart-of-accounts',
  '/accounting/default-accounts',
  '/accounting/currencies',
  '/accounting/exchange-rates',
  '/accounting/journal-entries',
  '/accounting/recurring-journals',
  '/accounting/fiscal-periods',

  // VAT
  '/accounting/reports/vat-return',
  '/accounting/vat-adjustments',
  '/accounting/drc-vat',

  // Accountant's Area
  '/accounting/trial-balance',
  '/accounting/reports/audit-trail',
  '/accounting/depreciation',
  '/accounting/year-end',
  '/accounting/cost-centres',
  '/accounting/business-units',
  '/accounting/budgets',

  // Reports
  '/accounting/reports/income-statement',
  '/accounting/reports/balance-sheet',
  '/accounting/reports/cash-flow',
  '/accounting/reports/budget-vs-actual',
  '/accounting/reports/project-profitability',
  '/accounting/reports/customer-reports',
  '/accounting/reports/supplier-reports',
  '/accounting/reports/bank-transactions',
  '/accounting/reports/account-transactions',

  // Data Import
  '/accounting/sage-migration',
];

// Expected tab labels in the horizontal nav bar
const EXPECTED_TABS = [
  'Dashboard',
  'Customers',
  'Suppliers',
  'Items',
  'Banking',
  'Accounts',
  'VAT',
  "Accountant's Area",
  'Reports',
  'Data Import',
];

// Dropdown tabs (not simple links) — should show chevron and open on click
const DROPDOWN_TABS = [
  'Customers',
  'Suppliers',
  'Items',
  'Banking',
  'Accounts',
  'VAT',
  "Accountant's Area",
  'Reports',
];

// Tab → route → expected active tab mapping for route resolver
const ROUTE_TAB_MAPPING: Record<string, string[]> = {
  items: [
    '/accounting/item-adjustments',
    '/accounting/item-pricing',
    '/accounting/reports/item-listing',
  ],
  vat: [
    '/accounting/vat-adjustments',
    '/accounting/drc-vat',
  ],
  accountants: [
    '/accounting/cost-centres',
    '/accounting/budgets',
    '/accounting/depreciation',
    '/accounting/year-end',
    '/accounting/business-units',
    '/accounting/trial-balance',
  ],
};

test.describe('Navigation bar', () => {
  test('renders all expected top-level tabs', async ({ page }) => {
    await page.goto('/accounting');
    const nav = page.locator('nav.bg-gray-900');

    for (const label of EXPECTED_TABS) {
      const tab = nav.getByText(label, { exact: true }).first();
      await expect(tab).toBeVisible();
    }
  });

  for (const label of DROPDOWN_TABS) {
    test(`"${label}" dropdown opens on click`, async ({ page }) => {
      await page.goto('/accounting');
      const nav = page.locator('nav.bg-gray-900');
      const btn = nav.getByRole('button', { name: label, exact: true });
      await btn.click();

      // Dropdown panel should appear below the button
      const dropdown = page.locator('nav.bg-gray-900 .absolute');
      await expect(dropdown.first()).toBeVisible();
    });
  }
});

test.describe('All nav routes load successfully', () => {
  for (const route of ALL_NAV_ROUTES) {
    test(`GET ${route} returns 200`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
    });
  }
});

test.describe('Route-to-tab highlighting', () => {
  for (const [expectedTab, routes] of Object.entries(ROUTE_TAB_MAPPING)) {
    for (const route of routes) {
      test(`${route} highlights "${expectedTab}" tab`, async ({ page }) => {
        await page.goto(route);
        const nav = page.locator('nav.bg-gray-900');

        // The active tab should have the emerald accent border class
        const activeTab = nav.locator('[class*="border-teal-500"]');
        await expect(activeTab.first()).toBeVisible();

        // Map tab IDs to display labels
        const tabLabels: Record<string, string> = {
          items: 'Items',
          vat: 'VAT',
          accountants: "Accountant's Area",
        };
        const label = tabLabels[expectedTab];
        if (label) {
          const tabEl = activeTab.filter({ hasText: label }).first();
          await expect(tabEl).toBeVisible();
        }
      });
    }
  }
});

test.describe('Branding', () => {
  test('shows IsaFlow in the header', async ({ page }) => {
    await page.goto('/accounting');
    await expect(page.locator('text=IsaFlow').first()).toBeVisible();
  });

  test('shows sign-in form on the login page', async ({ browser }) => {
    // Use a fresh context without auth to test the login page
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('text=Sign in').first()).toBeVisible({ timeout: 10000 });
    await context.close();
  });

  test('meta application-name is IsaFlow', async ({ page }) => {
    await page.goto('/accounting');
    const content = await page.getAttribute('meta[name="application-name"]', 'content');
    expect(content).toBe('IsaFlow');
  });
});
