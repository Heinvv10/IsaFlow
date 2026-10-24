/** The main screen of each golden path (a-l), scanned by n-a11y-main-screens.spec.ts. Specs d and m scan their own screens inline. */
export const A11Y_SCREENS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'a quotes list', path: '/accounting/customer-quotes' },
  { name: 'b invoices list', path: '/accounting/customer-invoices' },
  { name: 'b invoice new', path: '/accounting/customer-invoices/new' },
  { name: 'b customer payment new', path: '/accounting/customer-payments/new' },
  { name: 'e credit notes list', path: '/accounting/credit-notes' },
  { name: 'f bank transactions', path: '/accounting/bank-transactions' },
  { name: 'g journal new', path: '/accounting/journal-entries/new' },
  { name: 'h payroll runs', path: '/payroll/runs' },
  { name: 'i vat return', path: '/accounting/reports/vat-return' },
  { name: 'j fixed assets', path: '/accounting/assets' },
  { name: 'k month-end workbench', path: '/accounting/month-end-workbench' },
];
