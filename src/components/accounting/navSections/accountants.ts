import type { Tab } from './types';

export const accountantsTab: Tab = {
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
            { label: 'Audit Trail', href: '/accounting/audit-log' },
          ],
        },
        {
          section: 'Compliance & Export',
          items: [
            { label: 'IFRS Disclosure Notes', href: '/accounting/reports/disclosure-notes' },
            { label: 'CaseWare Export', href: '/accounting/reports/caseware-export' },
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
};
