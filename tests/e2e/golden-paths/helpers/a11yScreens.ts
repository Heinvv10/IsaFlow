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
}

/** The main screen of each golden path (a-l), scanned by n-a11y-main-screens.spec.ts. */
export const A11Y_SCREENS: ReadonlyArray<A11yScreen> = [
  { name: 'a quotes list', path: '/accounting/customer-quotes', heading: 'Customer Quotes' },
  { name: 'b invoices list', path: '/accounting/customer-invoices', heading: 'Tax Invoices' },
  { name: 'b invoice new', path: '/accounting/customer-invoices/new', heading: 'Customer Invoice' },
  { name: 'b customer payment new', path: '/accounting/customer-payments/new', heading: 'Record Customer Payment' },
  { name: 'e credit notes list', path: '/accounting/credit-notes', heading: 'Credit Notes' },
  { name: 'f bank transactions', path: '/accounting/bank-transactions', heading: 'Bank Transactions' },
  { name: 'g journal new', path: '/accounting/journal-entries/new', heading: 'Journal Entry' },
  { name: 'h payroll runs', path: '/payroll/runs', heading: 'Payroll Runs' },
  { name: 'i vat return', path: '/accounting/reports/vat-return', heading: 'VAT201 Return' },
  { name: 'j fixed assets', path: '/accounting/assets', heading: 'Fixed Assets' },
  { name: 'k month-end workbench', path: '/accounting/month-end-workbench', heading: 'Month-End Workbench' },
  // not a golden path: the one screen that uses the shared AccountPicker
  { name: 'account transactions (AccountPicker)', path: '/accounting/reports/account-transactions', heading: 'Account Transactions' },
];

/** Screens that specs d and m open for their own flows (each scans its own). */
export const A11Y_INLINE_SCREENS = {
  supplierPaymentNew: { name: 'd supplier payment new', path: '/accounting/supplier-payments/new', heading: 'New Supplier Payment' },
  migrationOpeningBalances: { name: 'm opening balances', path: '/accounting/migration/opening-balances', heading: 'Opening Balances' },
  migrationLanding: { name: 'm migration landing', path: '/accounting/migration', heading: 'Migration Wizard' },
} satisfies Record<string, A11yScreen>;

export const ALL_A11Y_SCREENS: ReadonlyArray<A11yScreen> = [...A11Y_SCREENS, ...Object.values(A11Y_INLINE_SCREENS)];

/** Baseline keys that are not a page: a piece of the app shell scanned on its own. */
export const A11Y_SHELL_KEYS = { setupGuideBadge: 'shell:setup-guide-badge' } as const;
