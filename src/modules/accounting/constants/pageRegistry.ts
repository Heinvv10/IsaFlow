/**
 * Page Registry — metadata for pages that can appear as quick actions.
 */

export interface PageMeta {
  path: string;
  title: string;
  description: string;
  icon: string;
  color: string;
}

export const PAGE_REGISTRY: Record<string, PageMeta> = {
  '/accounting/journal-entries/new': { path: '/accounting/journal-entries/new', title: 'New Journal Entry', description: 'Create a manual journal entry', icon: 'Plus', color: 'teal' },
  '/accounting/trial-balance': { path: '/accounting/trial-balance', title: 'Trial Balance', description: 'View trial balance report', icon: 'BarChart3', color: 'blue' },
  '/accounting/bank-reconciliation': { path: '/accounting/bank-reconciliation', title: 'Bank Reconciliation', description: 'Match statements to GL entries', icon: 'Landmark', color: 'indigo' },
  '/accounting/supplier-invoices': { path: '/accounting/supplier-invoices', title: 'Supplier Invoices', description: 'AP invoices, matching & approvals', icon: 'FileText', color: 'orange' },
  '/accounting/customer-payments': { path: '/accounting/customer-payments', title: 'Customer Payments', description: 'Record & allocate payments', icon: 'CreditCard', color: 'teal' },
  '/accounting/ar-aging': { path: '/accounting/ar-aging', title: 'AR Aging Report', description: 'Outstanding receivables by age', icon: 'TrendingUp', color: 'teal' },
  '/accounting/customer-invoices': { path: '/accounting/customer-invoices', title: 'Customer Invoices', description: 'View and manage tax invoices', icon: 'FileText', color: 'teal' },
  '/accounting/customer-invoices/new': { path: '/accounting/customer-invoices/new', title: 'New Invoice', description: 'Create a customer invoice', icon: 'Plus', color: 'teal' },
  '/accounting/supplier-invoices/new': { path: '/accounting/supplier-invoices/new', title: 'New Bill', description: 'Capture a supplier invoice', icon: 'Plus', color: 'orange' },
  '/accounting/customers': { path: '/accounting/customers', title: 'Customers', description: 'Manage customer accounts', icon: 'Users', color: 'teal' },
  '/accounting/suppliers': { path: '/accounting/suppliers', title: 'Suppliers', description: 'Manage supplier accounts', icon: 'Users', color: 'orange' },
  '/accounting/bank-transactions': { path: '/accounting/bank-transactions', title: 'Bank Transactions', description: 'View and categorize transactions', icon: 'CreditCard', color: 'blue' },
  '/accounting/chart-of-accounts': { path: '/accounting/chart-of-accounts', title: 'Chart of Accounts', description: 'Manage GL accounts', icon: 'BookOpen', color: 'purple' },
  '/accounting/journal-entries': { path: '/accounting/journal-entries', title: 'Journal Entries', description: 'View posted journals', icon: 'FileSpreadsheet', color: 'purple' },
  '/accounting/reports/income-statement': { path: '/accounting/reports/income-statement', title: 'Income Statement', description: 'Revenue and expense report', icon: 'BarChart3', color: 'teal' },
  '/accounting/reports/balance-sheet': { path: '/accounting/reports/balance-sheet', title: 'Balance Sheet', description: 'Assets, liabilities and equity', icon: 'BarChart3', color: 'blue' },
  '/accounting/reports/vat-return': { path: '/accounting/reports/vat-return', title: 'VAT Return', description: 'Prepare VAT201 return', icon: 'FileText', color: 'indigo' },
  '/accounting/ap-aging': { path: '/accounting/ap-aging', title: 'AP Aging Report', description: 'Outstanding payables by age', icon: 'TrendingUp', color: 'orange' },
  '/accounting/supplier-payments': { path: '/accounting/supplier-payments', title: 'Supplier Payments', description: 'Record supplier payments', icon: 'CreditCard', color: 'orange' },
  '/accounting/company-settings': { path: '/accounting/company-settings', title: 'Company Settings', description: 'Manage company configuration', icon: 'Calculator', color: 'gray' },
  '/accounting/customer-statements': { path: '/accounting/customer-statements', title: 'Customer Statements', description: 'Generate customer statements', icon: 'FileText', color: 'teal' },
  '/accounting/supplier-statements': { path: '/accounting/supplier-statements', title: 'Supplier Statements', description: 'View supplier statements', icon: 'FileText', color: 'orange' },
  '/accounting/fiscal-periods': { path: '/accounting/fiscal-periods', title: 'Fiscal Periods', description: 'Manage fiscal periods', icon: 'Calendar', color: 'purple' },
  '/accounting/migration': { path: '/accounting/migration', title: 'Data Import', description: 'Import data and migrations', icon: 'Upload', color: 'green' },
  '/accounting/audit-log': { path: '/accounting/audit-log', title: 'Audit Trail', description: 'View audit history', icon: 'FileSpreadsheet', color: 'gray' },
};

export const DEFAULT_QUICK_ACTIONS: string[] = [
  '/accounting/journal-entries/new',
  '/accounting/trial-balance',
  '/accounting/bank-reconciliation',
  '/accounting/supplier-invoices',
  '/accounting/customer-payments',
  '/accounting/ar-aging',
];
