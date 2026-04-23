import type { Tab } from './types';

export const salesTab: Tab = {
  id: 'sales', label: 'Sales',
  topItems: [
    { label: 'Add a Customer', href: '/accounting/customers/new' },
  ],
  items: [
    {
      section: 'Customers',
      items: [
        { label: 'List of Customers', href: '/accounting/customers' },
        { label: 'Customer Categories', href: '/accounting/customer-categories' },
        { label: 'Debtors Manager', href: '/accounting/debtors-manager' },
        { label: 'Find & Merge Duplicates', href: '/accounting/customers/dedup' },
      ],
    },
    {
      section: 'Transactions',
      items: [
        { label: 'Quotes', href: '/accounting/customer-quotes' },
        { label: 'Sales Orders', href: '/accounting/customer-sales-orders' },
        { label: 'Delivery Notes', href: '/accounting/delivery-notes' },
        { label: 'Tax Invoices', href: '/accounting/customer-invoices' },
        { label: 'Recurring Invoices', href: '/accounting/recurring-invoices' },
        { label: 'Receipts', href: '/accounting/customer-payments' },
        { label: 'Credit Notes', href: '/accounting/credit-notes' },
        { label: 'Write-Offs', href: '/accounting/write-offs' },
        { label: 'Allocate Receipts', href: '/accounting/customer-allocations' },
        { label: 'Receipt Auto-Match', href: '/accounting/ar/receipt-match' },
        { label: 'Adjustments', href: '/accounting/adjustments?type=customer' },
      ],
    },
    {
      section: 'Reports',
      items: [
        { label: 'Sales by Customer', href: '/accounting/reports/sales-by-customer' },
        { label: 'AR Aging', href: '/accounting/ar-aging' },
        { label: 'Statements', href: '/accounting/customer-statements' },
        { label: 'Generate Statement', href: '/accounting/customers/statement' },
        { label: 'Unallocated Receipts', href: '/accounting/reports/unallocated-receipts' },
        { label: 'Disputes', href: '/accounting/disputes' },
      ],
    },
    {
      section: 'Statement Run',
      items: [
        { label: 'Statement Run', href: '/accounting/statement-run' },
        { label: 'Send Statements', href: '/accounting/statements' },
        { label: 'Dunning', href: '/accounting/dunning' },
        { label: 'Dunning Templates', href: '/accounting/ar/dunning' },
        { label: 'Dunning Runs', href: '/accounting/ar/dunning/runs' },
        { label: 'Opening Balances', href: '/accounting/opening-balances' },
      ],
    },
  ],
};
