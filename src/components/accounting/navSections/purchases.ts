import type { Tab } from './types';

export const purchasesTab: Tab = {
  id: 'purchases', label: 'Purchases',
  topItems: [
    { label: 'Add a Supplier', href: '/accounting/suppliers/new' },
  ],
  items: [
    {
      section: 'Suppliers',
      items: [
        { label: 'List of Suppliers', href: '/accounting/suppliers' },
        { label: 'Supplier Categories', href: '/accounting/supplier-categories' },
        { label: 'Find & Merge Duplicates', href: '/accounting/suppliers/dedup' },
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
        { label: 'AP Aging', href: '/accounting/ap-aging' },
        { label: 'Statements', href: '/accounting/supplier-statements' },
        { label: 'Unallocated Payments', href: '/accounting/reports/unallocated-payments' },
      ],
    },
    {
      section: 'Capture',
      items: [
        { label: 'Inbox', href: '/accounting/capture/inbox' },
        { label: 'Capture Settings', href: '/accounting/capture/settings' },
      ],
    },
    {
      section: 'Special',
      items: [
        { label: 'Opening Balances', href: '/accounting/opening-balances' },
      ],
    },
  ],
};
