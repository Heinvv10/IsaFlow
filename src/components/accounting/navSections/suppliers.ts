import type { Tab } from './types';

export const suppliersTab: Tab = {
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
        { label: 'Purchase Orders', href: '/accounting/purchase-orders' },
        { label: 'Goods Received', href: '/accounting/goods-received' },
        { label: 'Invoices', href: '/accounting/supplier-invoices' },
        { label: 'Returns', href: '/accounting/supplier-returns' },
        { label: 'Payments', href: '/accounting/supplier-payments' },
        { label: 'Batch Payments', href: '/accounting/batch-payments' },
        { label: 'Allocate Payments', href: '/accounting/supplier-allocations' },
        { label: 'Credit Notes', href: '/accounting/supplier-credit-notes' },
        { label: 'Adjustments', href: '/accounting/adjustments?type=supplier' },
      ],
    },
    {
      section: 'Reports',
      items: [
        { label: 'Purchases by Supplier', href: '/accounting/reports/purchases-by-supplier' },
        { label: 'Supplier POs by Supplier', href: '/accounting/reports/supplier-pos' },
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
    {
      section: 'Automation',
      items: [
        { label: 'Coding Rules', href: '/accounting/suppliers/rules' },
        { label: 'Expectations', href: '/accounting/suppliers/expectations' },
        { label: 'Missing Invoices', href: '/accounting/suppliers/missing-invoices' },
        { label: 'Statement Reconciliation', href: '/accounting/ap/supplier-statements' },
      ],
    },
    {
      section: 'Data Quality',
      items: [
        { label: 'Find & Merge Duplicates', href: '/accounting/suppliers/dedup' },
      ],
    },
    {
      section: 'Settings',
      items: [
        { label: 'Supplier Settings', href: '/accounting/company-settings?tab=documents', isSetting: true },
      ],
    },
  ],
};
