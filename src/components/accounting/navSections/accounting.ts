import type { Tab } from './types';

export const accountingTab: Tab = {
  id: 'accounting', label: 'Accounting',
  topItems: [
    { label: 'New Journal Entry', href: '/accounting/journal-entries/new' },
  ],
  items: [
    {
      section: 'General Ledger',
      items: [
        { label: 'Chart of Accounts', href: '/accounting/chart-of-accounts' },
        { label: 'Default Accounts', href: '/accounting/default-accounts' },
        { label: 'Reporting Groups', href: '/accounting/settings/account-reporting-groups' },
        { label: 'Currencies', href: '/accounting/settings/currencies' },
        { label: 'Exchange Rates', href: '/accounting/settings/exchange-rates' },
      ],
    },
    {
      section: 'Journals',
      items: [
        { label: 'Journal Entries', href: '/accounting/journal-entries' },
        { label: 'Recurring Journals', href: '/accounting/recurring-journals' },
        { label: 'Auto-Postings', href: '/accounting/auto-postings' },
      ],
    },
    {
      section: 'Periods',
      items: [
        { label: 'Fiscal Periods', href: '/accounting/fiscal-periods' },
        { label: 'Financial Years', href: '/accounting/financial-years' },
        { label: 'Year-End', href: '/accounting/year-end' },
      ],
    },
    {
      section: 'Trial Balance & Audit',
      items: [
        { label: 'Trial Balance', href: '/accounting/trial-balance' },
        { label: 'Opening Balances', href: '/accounting/opening-balances' },
        { label: 'Audit Trail', href: '/accounting/audit-log' },
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
      section: 'Management Accounting',
      items: [
        { label: 'Cost Centres', href: '/accounting/cost-centres' },
        { label: 'Business Units', href: '/accounting/business-units' },
        { label: 'Budgets', href: '/accounting/budgets' },
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
