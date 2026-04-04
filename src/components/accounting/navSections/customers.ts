import type { Tab } from './types';

export const customersTab: Tab = {
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
        { label: 'Sales Orders', href: '/accounting/customer-sales-orders' },
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
    {
      section: 'Settings',
      items: [
        { label: 'Customer Settings', href: '/accounting/company-settings?tab=documents', isSetting: true },
      ],
    },
  ],
};
