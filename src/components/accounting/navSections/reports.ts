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
        { label: 'Cash Flow Forecast', href: '/accounting/reports/cash-flow-forecast' },
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
      section: 'Aging Analysis',
      items: [
        { label: 'AR Age Analysis', href: '/accounting/reports/ar-aging' },
        { label: 'AP Age Analysis', href: '/accounting/reports/ap-aging' },
      ],
    },
    {
      section: 'Transactional',
      items: [
        { label: 'Customer Report', href: '/accounting/reports/customer-reports' },
        { label: 'Supplier Report', href: '/accounting/reports/supplier-reports' },
        { label: 'Bank Transactions', href: '/accounting/reports/bank-transactions' },
        { label: 'Account Transactions', href: '/accounting/reports/account-transactions' },
        { label: 'Journal Entries', href: '/accounting/reports/journal-entries' },
        { label: 'VAT Return', href: '/accounting/reports/vat-return' },
        { label: 'Audit Trail', href: '/accounting/audit-log' },
      ],
    },
    {
      section: 'Annual Financial Statements',
      items: [
        { label: 'All AFS Documents', href: '/accounting/afs' },
        { label: 'IFRS Disclosure Notes', href: '/accounting/reports/disclosure-notes' },
        { label: 'CaseWare Export', href: '/accounting/reports/caseware-export' },
      ],
    },
    {
      section: 'Management Packs',
      items: [
        { label: 'Management Packs', href: '/accounting/afs/management-packs' },
        { label: 'Pack Documents', href: '/accounting/afs?type=management_pack' },
        { label: 'Portal Contacts', href: '/accounting/afs/portal-contacts' },
      ],
    },
    {
      section: 'Custom Reports',
      items: [
        { label: 'Report Builder', href: '/accounting/reports/builder' },
        { label: 'My Reports', href: '/accounting/reports/my-reports' },
      ],
    },
    {
      section: 'Audit',
      items: [
        { label: 'Audit Trail', href: '/accounting/audit-trail' },
      ],
    },
  ],
};
