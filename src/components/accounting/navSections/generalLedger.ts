import type { Tab } from './types';

export const accountsTab: Tab = {
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
    {
      section: 'Settings',
      items: [
        { label: 'Accounting Settings', href: '/accounting/accounting-settings', isSetting: true },
      ],
    },
  ],
};

export const vatTab: Tab = {
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
    {
      section: 'Settings',
      items: [
        { label: 'VAT Settings', href: '/accounting/company-settings?tab=vat', isSetting: true },
      ],
    },
  ],
};
