import type { Tab } from './types';

export const bankingTab: Tab = {
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
    {
      section: 'Settings',
      items: [
        { label: 'Banking Settings', href: '/accounting/company-settings?tab=general', isSetting: true },
      ],
    },
  ],
};
