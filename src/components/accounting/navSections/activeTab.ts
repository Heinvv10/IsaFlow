export function getActiveTabId(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
): string {
  if (pathname === '/accounting') return 'dashboard';
  if (pathname.startsWith('/accounting/migration')) return 'import';
  if (pathname.startsWith('/accounting/sage-migration')) return 'import';

  // Customers
  if (
    pathname.startsWith('/accounting/customers') ||
    pathname.startsWith('/accounting/customer-') ||
    pathname.startsWith('/accounting/recurring-invoices') ||
    pathname.startsWith('/accounting/credit-notes') ||
    pathname.startsWith('/accounting/write-offs') ||
    pathname.startsWith('/accounting/debtors-manager') ||
    pathname.startsWith('/accounting/ar-aging') ||
    pathname.startsWith('/accounting/statement-run') ||
    pathname.startsWith('/accounting/dunning') ||
    pathname === '/accounting/reports/sales-by-customer' ||
    pathname === '/accounting/reports/unallocated-receipts' ||
    (pathname.startsWith('/accounting/adjustments') && query.type === 'customer')
  ) {
    return 'customers';
  }

  // Suppliers
  if (
    pathname.startsWith('/accounting/suppliers') ||
    pathname.startsWith('/accounting/supplier-') ||
    pathname.startsWith('/accounting/purchase-orders') ||
    pathname.startsWith('/accounting/batch-payments') ||
    pathname.startsWith('/accounting/ap-aging') ||
    pathname === '/accounting/reports/purchases-by-supplier' ||
    pathname === '/accounting/reports/unallocated-payments' ||
    (pathname.startsWith('/accounting/adjustments') && query.type === 'supplier')
  ) {
    return 'suppliers';
  }

  // Items
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
    return 'items';
  }

  // Banking
  if (pathname.startsWith('/accounting/bank-')) return 'banking';

  // Accounts
  if (
    pathname.startsWith('/accounting/chart-of-accounts') ||
    pathname.startsWith('/accounting/journal-entries') ||
    pathname.startsWith('/accounting/recurring-journals') ||
    pathname.startsWith('/accounting/fiscal-periods') ||
    pathname.startsWith('/accounting/default-accounts') ||
    pathname.startsWith('/accounting/currencies') ||
    pathname.startsWith('/accounting/exchange-rates')
  ) {
    return 'accounts';
  }

  // VAT
  if (
    pathname.startsWith('/accounting/vat-') ||
    pathname.startsWith('/accounting/drc-vat') ||
    pathname === '/accounting/reports/vat-return'
  ) {
    return 'vat';
  }

  // Accountant's Area
  if (
    pathname.startsWith('/accounting/trial-balance') ||
    pathname.startsWith('/accounting/opening-balances') ||
    pathname.startsWith('/accounting/assets') ||
    pathname.startsWith('/accounting/depreciation') ||
    pathname.startsWith('/accounting/year-end') ||
    pathname.startsWith('/accounting/cost-centres') ||
    pathname.startsWith('/accounting/business-units') ||
    pathname.startsWith('/accounting/budgets')
  ) {
    return 'accountants';
  }

  // Group
  if (pathname.startsWith('/accounting/group')) return 'group';

  // SARS
  if (pathname.startsWith('/accounting/sars')) return 'sars';

  // Tools
  if (
    pathname.startsWith('/accounting/document-capture') ||
    pathname.startsWith('/accounting/approvals') ||
    pathname.startsWith('/accounting/company-settings') ||
    pathname.startsWith('/accounting/my-account') ||
    pathname.startsWith('/accounting/cash-flow-forecast') ||
    pathname.startsWith('/accounting/time-tracking') ||
    pathname.startsWith('/accounting/user-access') ||
    pathname.startsWith('/accounting/audit-log') ||
    pathname.startsWith('/accounting/gl-import') ||
    pathname.startsWith('/accounting/duplicates') ||
    pathname.startsWith('/accounting/data-archiving') ||
    pathname.startsWith('/accounting/webhooks') ||
    pathname.startsWith('/accounting/recurring-transactions')
  ) {
    return 'tools';
  }

  if (pathname.startsWith('/accounting/reports')) return 'reports';

  // Payroll
  if (pathname.startsWith('/payroll')) return 'payroll';

  return 'dashboard';
}

export function isLinkActive(href: string, asPath: string): boolean {
  const parts = href.split('?');
  const itemPath = parts[0] as string;
  const qs = parts[1];
  return asPath.startsWith(itemPath) && (!qs || asPath.includes(qs));
}
