import type { Tab } from './types';

export const reportsTab: Tab = {
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
    {
      section: 'Custom Reports',
      items: [
        { label: 'Report Builder', href: '/accounting/reports/builder' },
        { label: 'My Reports', href: '/accounting/reports/my-reports' },
      ],
    },
  ],
};

export const sarsTab: Tab = {
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
};
