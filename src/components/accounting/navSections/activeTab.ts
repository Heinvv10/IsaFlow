/**
 * Route → tab id resolver for the Option B 9-menu spine.
 *
 * Tabs: dashboard · sales · purchases · inventory · banking ·
 *       accounting · reports · tax · payroll · (settings — cog only)
 */

export function getActiveTabId(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
): string {
  if (pathname === '/accounting') {
    const tab = typeof query.tab === 'string' ? query.tab : undefined;
    if (tab === 'chart-of-accounts' || tab === 'journal-entries' || tab === 'fiscal-periods') return 'accounting';
    if (tab === 'reports') return 'reports';
    return 'dashboard';
  }

  // ── Settings (cog) ──────────────────────────────────────────────────────
  if (
    pathname.startsWith('/accounting/company-settings') ||
    pathname.startsWith('/accounting/user-access') ||
    pathname.startsWith('/accounting/my-account') ||
    pathname.startsWith('/accounting/document-capture') ||
    pathname.startsWith('/accounting/approvals') ||
    pathname.startsWith('/accounting/recurring-transactions') ||
    pathname.startsWith('/accounting/webhooks') ||
    pathname.startsWith('/accounting/time-tracking') ||
    pathname.startsWith('/accounting/timesheets') ||
    pathname.startsWith('/accounting/duplicates') ||
    pathname.startsWith('/accounting/data-archiving') ||
    pathname.startsWith('/accounting/migration') ||
    pathname.startsWith('/accounting/sage-migration') ||
    pathname.startsWith('/accounting/gl-import') ||
    pathname.startsWith('/accounting/group') ||
    pathname.startsWith('/accounting/consolidation')
  ) {
    return 'settings';
  }

  // ── Sales (formerly Customers) ──────────────────────────────────────────
  if (
    pathname.startsWith('/accounting/customers') ||
    pathname.startsWith('/accounting/customer-') ||
    pathname.startsWith('/accounting/recurring-invoices') ||
    pathname.startsWith('/accounting/credit-notes') ||
    pathname.startsWith('/accounting/write-offs') ||
    pathname.startsWith('/accounting/debtors-manager') ||
    pathname.startsWith('/accounting/ar-aging') ||
    pathname.startsWith('/accounting/statement-run') ||
    pathname.startsWith('/accounting/statements') ||
    pathname.startsWith('/accounting/dunning') ||
    pathname.startsWith('/accounting/ar/') ||
    pathname === '/accounting/reports/sales-by-customer' ||
    pathname === '/accounting/reports/unallocated-receipts' ||
    (pathname.startsWith('/accounting/adjustments') && query.type === 'customer')
  ) {
    return 'sales';
  }

  // ── Purchases (formerly Suppliers) ──────────────────────────────────────
  if (
    pathname.startsWith('/accounting/suppliers') ||
    pathname.startsWith('/accounting/supplier-') ||
    pathname.startsWith('/accounting/purchase-orders') ||
    pathname.startsWith('/accounting/goods-received') ||
    pathname.startsWith('/accounting/batch-payments') ||
    pathname.startsWith('/accounting/ap-aging') ||
    pathname === '/accounting/reports/purchases-by-supplier' ||
    pathname === '/accounting/reports/supplier-pos' ||
    pathname === '/accounting/reports/unallocated-payments' ||
    (pathname.startsWith('/accounting/adjustments') && query.type === 'supplier')
  ) {
    return 'purchases';
  }

  // ── Inventory (formerly Items) ──────────────────────────────────────────
  if (
    pathname.startsWith('/accounting/items') ||
    pathname.startsWith('/accounting/item-') ||
    pathname === '/accounting/reports/item-listing' ||
    pathname === '/accounting/reports/sales-by-item' ||
    pathname === '/accounting/reports/purchases-by-item' ||
    pathname === '/accounting/reports/item-movement' ||
    pathname === '/accounting/reports/item-valuation' ||
    pathname === '/accounting/reports/item-quantities'
  ) {
    return 'inventory';
  }

  // ── Banking ─────────────────────────────────────────────────────────────
  if (pathname.startsWith('/accounting/bank-')) return 'banking';

  // ── Tax (VAT + SARS + Payroll SARS submissions) ─────────────────────────
  if (
    pathname.startsWith('/accounting/vat-') ||
    pathname.startsWith('/accounting/drc-vat') ||
    pathname.startsWith('/accounting/sars') ||
    pathname === '/accounting/reports/vat-return' ||
    pathname === '/accounting/reports/vat-reconciliation' ||
    pathname.startsWith('/payroll/emp201') ||
    pathname.startsWith('/payroll/emp501') ||
    pathname.startsWith('/payroll/irp5') ||
    pathname.startsWith('/payroll/uif') ||
    pathname.startsWith('/payroll/tax-directives') ||
    pathname.startsWith('/payroll/year-end')
  ) {
    return 'tax';
  }

  // ── Accounting (CoA + GL + journals + periods + assets + management) ────
  if (
    pathname.startsWith('/accounting/chart-of-accounts') ||
    pathname.startsWith('/accounting/journal-entries') ||
    pathname.startsWith('/accounting/recurring-journals') ||
    pathname.startsWith('/accounting/auto-postings') ||
    pathname.startsWith('/accounting/fiscal-periods') ||
    pathname.startsWith('/accounting/financial-years') ||
    pathname.startsWith('/accounting/year-end') ||
    pathname.startsWith('/accounting/default-accounts') ||
    pathname.startsWith('/accounting/currencies') ||
    pathname.startsWith('/accounting/exchange-rates') ||
    pathname.startsWith('/accounting/settings/currencies') ||
    pathname.startsWith('/accounting/settings/exchange-rates') ||
    pathname.startsWith('/accounting/settings/account-reporting-groups') ||
    pathname.startsWith('/accounting/accounting-settings') ||
    pathname.startsWith('/accounting/trial-balance') ||
    pathname.startsWith('/accounting/opening-balances') ||
    pathname.startsWith('/accounting/audit-log') ||
    pathname.startsWith('/accounting/assets') ||
    pathname.startsWith('/accounting/depreciation') ||
    pathname.startsWith('/accounting/cost-centres') ||
    pathname.startsWith('/accounting/business-units') ||
    pathname.startsWith('/accounting/budgets')
  ) {
    return 'accounting';
  }

  // ── Reports (incl. AFS, Management Packs) ───────────────────────────────
  if (
    pathname.startsWith('/accounting/afs') ||
    pathname.startsWith('/accounting/reports')
  ) {
    return 'reports';
  }

  // ── Payroll (employees, runs, leave only — SARS bits live under Tax) ────
  if (pathname.startsWith('/payroll')) return 'payroll';

  return 'dashboard';
}

export function isLinkActive(href: string, asPath: string): boolean {
  const parts = href.split('?');
  const itemPath = parts[0] as string;
  const qs = parts[1];
  return asPath.startsWith(itemPath) && (!qs || asPath.includes(qs));
}
