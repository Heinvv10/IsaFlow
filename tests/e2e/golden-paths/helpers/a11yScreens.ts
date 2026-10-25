import type { Page } from '@playwright/test';

/**
 * The screens the a11y gate scans. `heading` is the page's own <h1>: the scan only runs once the browser is on
 * `path` AND that heading is showing, so a redirect to /login (or to a dashboard tab that happens to have an
 * <h1>) fails the gate instead of being scanned under the wrong page's baseline.
 */
export interface A11yScreen {
  name: string;
  /** Path the browser must end on; a query, when given, must be present too. */
  path: string;
  heading: string;
  /** Responses the page must have received before it is scanned (registered before the navigation). */
  responses?: RegExp[];
  /** Resolves once the page has rendered what it will render; replaces the generic spinner wait. */
  settled?: (page: Page) => Promise<void>;
  /** A data table, scanned apart from the page (baseline key `<page>#rows`) so its row-driven counts stay out of the page's entries. */
  rowsTable?: string;
}

/** The main screen of each golden path (a-m), scanned by n-a11y-main-screens.spec.ts. */
export const A11Y_SCREENS: ReadonlyArray<A11yScreen> = [
  { name: 'a quotes list', path: '/accounting/customer-quotes', heading: 'Customer Quotes' },
  { name: 'b invoices list', path: '/accounting/customer-invoices', heading: 'Tax Invoices' },
  { name: 'b invoice new', path: '/accounting/customer-invoices/new', heading: 'Customer Invoice' },
  { name: 'b customer payment new', path: '/accounting/customer-payments/new', heading: 'Record Customer Payment' },
  { name: 'e credit notes list', path: '/accounting/credit-notes', heading: 'Credit Notes' },
  {
    name: 'f bank transactions', path: '/accounting/bank-transactions', heading: 'Bank Transactions',
    // The table's columns (CC1/CC2/BU) come from the accounting settings, its options from the ref data, and an
    // "AI is categorizing" spinner comes and goes: wait for the data, then for rows or the empty state.
    responses: [/\/api\/accounting\/bank-transactions\?/, /\/api\/accounting\/accounting-settings\?/, /\/api\/accounting\/bank-accounts/, /\/api\/accounting\/chart-of-accounts/, /\/api\/accounting\/customers/, /\/api\/accounting\/cost-centres/],
    settled: (page) => page.locator('[data-testid="bank-tx-table"] tbody tr, [data-testid="bank-tx-empty"]').first().waitFor({ state: 'visible', timeout: 30_000 }),
    rowsTable: '[data-testid="bank-tx-table"]',
  },
  { name: 'g journal new', path: '/accounting/journal-entries/new', heading: 'Journal Entry' },
  { name: 'h payroll runs', path: '/payroll/runs', heading: 'Payroll Runs' },
  { name: 'i vat201 return', path: '/accounting/sars/vat201', heading: 'VAT201 Return' },
  { name: 'j fixed assets', path: '/accounting/assets', heading: 'Fixed Assets' },
  { name: 'k month-end workbench', path: '/accounting/month-end-workbench', heading: 'Month-End Workbench' },
  { name: 'd supplier payment new', path: '/accounting/supplier-payments/new', heading: 'New Supplier Payment' },
  { name: 'm opening balances', path: '/accounting/migration/opening-balances', heading: 'Opening Balances' },
  { name: 'm migration landing', path: '/accounting/migration', heading: 'Migration Wizard' },
  // not a golden path: the one screen that uses the shared AccountPicker
  { name: 'account transactions (AccountPicker)', path: '/accounting/reports/account-transactions', heading: 'Account Transactions' },
];

/** Baseline keys that are not a page: a piece of the app shell scanned on its own. */
export const A11Y_SHELL_KEYS = { setupGuideBadge: 'shell:setup-guide-badge' } as const;
