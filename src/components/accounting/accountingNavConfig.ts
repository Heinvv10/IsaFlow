/**
 * AccountingNav configuration — tab definitions and route resolution.
 * Standalone version: all routes are internal /accounting/* paths.
 * /clients routes replaced with /accounting/customers.
 * /suppliers routes replaced with /accounting/suppliers.
 * External links to /procurement/purchase-orders, /stock-items, /inventory removed.
 */

export interface DropdownItem {
  label: string;
  href: string;
}

export interface FlyoutSection {
  section: string;
  items: NavItem[];
}

export type NavItem = DropdownItem | FlyoutSection;

export function isFlyout(item: NavItem): item is FlyoutSection {
  return 'section' in item;
}

export interface Tab {
  id: string;
  label: string;
  href?: string;
  topItems?: DropdownItem[];
  items?: NavItem[];
}

export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  {
    id: 'customers', label: 'Customers',
    topItems: [
      { label: 'Add a Customer', href: '/accounting/customers/new' },
    ],
    items: [
      {
        section: 'Lists',
        items: [
          { label: 'List of Customers', href: '/accounting/customers' },
          { label: 'Customer Categories', href: '/accounting/customer-categories' },
        ],
      },
      {
        section: 'Transactions',
        items: [
          { label: 'Quotes', href: '/accounting/customer-quotes' },
          { label: 'Tax Invoices', href: '/accounting/customer-invoices' },
          { label: 'Recurring Invoices', href: '/accounting/recurring-invoices' },
          { label: 'Receipts', href: '/accounting/customer-payments' },
          { label: 'Credit Notes', href: '/accounting/credit-notes' },
          { label: 'Write-Offs', href: '/accounting/write-offs' },
          { label: 'Allocate Receipts', href: '/accounting/customer-allocations' },
          { label: 'Adjustments', href: '/accounting/adjustments?type=customer' },
        ],
      },
      {
        section: 'Reports',
        items: [
          { label: 'Sales by Customer', href: '/accounting/reports/sales-by-customer' },
          { label: 'Aging', href: '/accounting/ar-aging' },
          { label: 'Statements', href: '/accounting/customer-statements' },
          { label: 'Unallocated Receipts', href: '/accounting/reports/unallocated-receipts' },
        ],
      },
      {
        section: 'Special',
        items: [
          { label: 'Statement Run', href: '/accounting/statement-run' },
          { label: 'Dunning', href: '/accounting/dunning' },
          { label: 'Opening Balances', href: '/accounting/opening-balances' },
        ],
      },
      {
        section: 'Debtors Manager',
        items: [
          { label: 'Debtors Manager', href: '/accounting/debtors-manager' },
        ],
      },
    ],
  },
  {
    id: 'suppliers', label: 'Suppliers',
    topItems: [
      { label: 'Add a Supplier', href: '/accounting/suppliers/new' },
    ],
    items: [
      {
        section: 'Lists',
        items: [
          { label: 'List of Suppliers', href: '/accounting/suppliers' },
          { label: 'Supplier Categories', href: '/accounting/supplier-categories' },
        ],
      },
      {
        section: 'Transactions',
        items: [
          { label: 'Invoices', href: '/accounting/supplier-invoices' },
          { label: 'Returns', href: '/accounting/supplier-returns' },
          { label: 'Payments', href: '/accounting/supplier-payments' },
          { label: 'Batch Payments', href: '/accounting/batch-payments' },
          { label: 'Allocate Payments', href: '/accounting/supplier-allocations' },
          { label: 'Adjustments', href: '/accounting/adjustments?type=supplier' },
        ],
      },
      {
        section: 'Reports',
        items: [
          { label: 'Purchases by Supplier', href: '/accounting/reports/purchases-by-supplier' },
          { label: 'Aging', href: '/accounting/ap-aging' },
          { label: 'Statements', href: '/accounting/supplier-statements' },
          { label: 'Unallocated Payments', href: '/accounting/reports/unallocated-payments' },
        ],
      },
      {
        section: 'Special',
        items: [
          { label: 'Opening Balances', href: '/accounting/opening-balances' },
        ],
      },
    ],
  },
  {
    id: 'items', label: 'Items',
    items: [
      {
        section: 'Transactions',
        items: [
          { label: 'Item Adjustments', href: '/accounting/item-adjustments' },
          { label: 'Adjust Selling Prices', href: '/accounting/item-pricing' },
        ],
      },
      {
        section: 'Special',
        items: [
          { label: 'Item Opening Balances', href: '/accounting/item-opening-balances' },
        ],
      },
      {
        section: 'Reports',
        items: [
          { label: 'Item Listing', href: '/accounting/reports/item-listing' },
          { label: 'Sales by Item', href: '/accounting/reports/sales-by-item' },
          { label: 'Purchases by Item', href: '/accounting/reports/purchases-by-item' },
          { label: 'Item Movement', href: '/accounting/reports/item-movement' },
          { label: 'Item Valuation', href: '/accounting/reports/item-valuation' },
          { label: 'Item Quantities', href: '/accounting/reports/item-quantities' },
        ],
      },
    ],
  },
  {
    id: 'banking', label: 'Banking',
    items: [
      {
        section: 'Lists',
        items: [
          { label: 'Bank Accounts', href: '/accounting/bank-accounts' },
        ],
      },
      {
        section: 'Transactions',
        items: [
          { label: 'Transactions', href: '/accounting/bank-transactions' },
          { label: 'Import Statement', href: '/accounting/bank-reconciliation/import' },
          { label: 'Reconcile', href: '/accounting/bank-reconciliation' },
          { label: 'Transfers', href: '/accounting/bank-transfers' },
        ],
      },
      {
        section: 'Special',
        items: [
          { label: 'Mapping Rules', href: '/accounting/bank-reconciliation/rules' },
          { label: 'Bank Feeds', href: '/accounting/bank-feeds' },
        ],
      },
    ],
  },
  {
    id: 'accounts', label: 'Accounts',
    items: [
      {
        section: 'Lists',
        items: [
          { label: 'Chart of Accounts', href: '/accounting/chart-of-accounts' },
          { label: 'Default Accounts', href: '/accounting/default-accounts' },
          { label: 'Currencies', href: '/accounting/currencies' },
          { label: 'Exchange Rates', href: '/accounting/exchange-rates' },
        ],
      },
      {
        section: 'Transactions',
        items: [
          { label: 'Journal Entries', href: '/accounting/journal-entries' },
          { label: 'Recurring Journals', href: '/accounting/recurring-journals' },
        ],
      },
      {
        section: 'Special',
        items: [
          { label: 'Fiscal Periods', href: '/accounting/fiscal-periods' },
        ],
      },
    ],
  },
  {
    id: 'vat', label: 'VAT',
    items: [
      {
        section: 'Returns',
        items: [
          { label: 'VAT Return', href: '/accounting/reports/vat-return' },
        ],
      },
      {
        section: 'Transactions',
        items: [
          { label: 'VAT Adjustments', href: '/accounting/vat-adjustments' },
          { label: 'DRC VAT', href: '/accounting/drc-vat' },
        ],
      },
    ],
  },
  {
    id: 'accountants', label: "Accountant's Area",
    topItems: [
      { label: 'Process Journal Entries', href: '/accounting/journal-entries' },
      { label: 'Recurring Journal Entries', href: '/accounting/recurring-journals' },
    ],
    items: [
      {
        section: 'VAT',
        items: [
          { label: 'VAT Return', href: '/accounting/reports/vat-return' },
          { label: 'VAT Adjustments', href: '/accounting/vat-adjustments' },
          { label: 'DRC VAT', href: '/accounting/drc-vat' },
        ],
      },
      {
        section: 'Reports',
        items: [
          {
            section: 'Management Reports',
            items: [
              { label: 'Income Statement', href: '/accounting/reports/income-statement' },
              { label: 'Balance Sheet', href: '/accounting/reports/balance-sheet' },
              { label: 'Trial Balance', href: '/accounting/trial-balance' },
              { label: 'Budget vs Actual', href: '/accounting/reports/budget-vs-actual' },
            ],
          },
          {
            section: 'Transaction Reports',
            items: [
              { label: 'Account Transactions', href: '/accounting/reports/account-transactions' },
            ],
          },
          {
            section: 'Audit Reports',
            items: [
              { label: 'Opening Balances', href: '/accounting/opening-balances' },
              { label: 'Audit Trail', href: '/accounting/reports/audit-trail' },
            ],
          },
        ],
      },
      {
        section: 'Fixed Assets',
        items: [
          { label: 'Asset Register', href: '/accounting/assets' },
          { label: 'Add Asset', href: '/accounting/assets/new' },
          { label: 'SARS Categories', href: '/accounting/assets/categories' },
          { label: 'Disposals', href: '/accounting/assets/disposals' },
          { label: 'Register Report', href: '/accounting/assets/register' },
          { label: 'Depreciation', href: '/accounting/depreciation' },
        ],
      },
      {
        section: 'Transactions',
        items: [
          { label: 'Year-End', href: '/accounting/year-end' },
        ],
      },
      {
        section: 'Management',
        items: [
          { label: 'Cost Centres', href: '/accounting/cost-centres' },
          { label: 'Business Units', href: '/accounting/business-units' },
          { label: 'Budgets', href: '/accounting/budgets' },
        ],
      },
    ],
  },
  {
    id: 'reports', label: 'Reports',
    items: [
      {
        section: 'Financial',
        items: [
          { label: 'Income Statement', href: '/accounting/reports/income-statement' },
          { label: 'Balance Sheet', href: '/accounting/reports/balance-sheet' },
          { label: 'Cash Flow', href: '/accounting/reports/cash-flow' },
          { label: 'Cash Flow Forecast', href: '/accounting/cash-flow-forecast' },
        ],
      },
      {
        section: 'Management',
        items: [
          { label: 'Budget vs Actual', href: '/accounting/reports/budget-vs-actual' },
          { label: 'Project Profitability', href: '/accounting/reports/project-profitability' },
          { label: 'Trial Balance', href: '/accounting/trial-balance' },
        ],
      },
      {
        section: 'Transactional',
        items: [
          { label: 'Customer Report', href: '/accounting/reports/customer-reports' },
          { label: 'Supplier Report', href: '/accounting/reports/supplier-reports' },
          { label: 'Bank Transactions', href: '/accounting/reports/bank-transactions' },
          { label: 'Account Transactions', href: '/accounting/reports/account-transactions' },
          { label: 'VAT Return', href: '/accounting/reports/vat-return' },
          { label: 'Audit Trail', href: '/accounting/reports/audit-trail' },
        ],
      },
    ],
  },
  {
    id: 'sars', label: 'SARS',
    items: [
      {
        section: 'Submissions',
        items: [
          { label: 'VAT201', href: '/accounting/sars/vat201' },
          { label: 'EMP201', href: '/accounting/sars/emp201' },
        ],
      },
      {
        section: 'Management',
        items: [
          { label: 'Compliance Calendar', href: '/accounting/sars' },
          { label: 'Submission History', href: '/accounting/sars/submissions' },
        ],
      },
    ],
  },
  {
    id: 'tools', label: 'Tools',
    items: [
      {
        section: 'Documents',
        items: [
          { label: 'Document Capture', href: '/accounting/document-capture' },
        ],
      },
      {
        section: 'Workflows',
        items: [
          { label: 'Approvals', href: '/accounting/approvals' },
        ],
      },
      {
        section: 'Productivity',
        items: [
          { label: 'Time Tracking', href: '/accounting/time-tracking' },
        ],
      },
      {
        section: 'Settings',
        items: [
          { label: 'Company Settings', href: '/accounting/company-settings' },
        ],
      },
    ],
  },
  {
    id: 'group', label: 'Group',
    items: [
      {
        section: 'Overview',
        items: [
          { label: 'Group Dashboard', href: '/accounting/group' },
          { label: 'Group Setup', href: '/accounting/group/setup' },
        ],
      },
      {
        section: 'Consolidated Reports',
        items: [
          { label: 'Consolidated Trial Balance', href: '/accounting/group/trial-balance' },
          { label: 'Consolidated Income Statement', href: '/accounting/group/income-statement' },
          { label: 'Consolidated Balance Sheet', href: '/accounting/group/balance-sheet' },
        ],
      },
      {
        section: 'Intercompany',
        items: [
          { label: 'Intercompany Reconciliation', href: '/accounting/group/intercompany' },
          { label: 'Elimination Adjustments', href: '/accounting/group/eliminations' },
        ],
      },
    ],
  },
  { id: 'import', label: 'Data Import', href: '/accounting/sage-migration' },
  {
    id: 'payroll', label: 'Payroll',
    items: [
      {
        section: 'Lists',
        items: [
          { label: 'Employees', href: '/payroll/employees' },
        ],
      },
      {
        section: 'Processing',
        items: [
          { label: 'Payroll Runs', href: '/payroll/runs' },
          { label: 'New Payroll Run', href: '/payroll/runs/new' },
        ],
      },
    ],
  },
];

export function getActiveTabId(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
): string {
  if (pathname === '/accounting') return 'dashboard';
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
    pathname.startsWith('/accounting/budgets') ||
    pathname === '/accounting/reports/audit-trail'
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
    pathname.startsWith('/accounting/cash-flow-forecast') ||
    pathname.startsWith('/accounting/time-tracking')
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
