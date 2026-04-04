import type { Tab } from './types';

export const toolsTab: Tab = {
  id: 'tools', label: 'Tools',
  items: [
    {
      section: 'Documents',
      items: [
        { label: 'Document Capture', href: '/accounting/document-capture' },
      ],
    },
    {
      section: 'Workflows',
      items: [
        { label: 'Approvals', href: '/accounting/approvals' },
        { label: 'Recurring Transactions', href: '/accounting/recurring-transactions' },
        { label: 'Webhooks', href: '/accounting/webhooks' },
      ],
    },
    {
      section: 'Audit & Compliance',
      items: [
        { label: 'Audit Trail', href: '/accounting/audit-log' },
      ],
    },
    {
      section: 'Productivity',
      items: [
        { label: 'Time Tracking', href: '/accounting/time-tracking' },
      ],
    },
    {
      section: 'Settings',
      items: [
        { label: 'Company Settings', href: '/accounting/company-settings' },
        { label: 'User Access', href: '/accounting/user-access' },
        { label: 'My Account', href: '/accounting/my-account' },
      ],
    },
    {
      section: 'Data Quality',
      items: [
        { label: 'Duplicate Detection', href: '/accounting/duplicates' },
      ],
    },
    {
      section: 'Data Management',
      items: [
        { label: 'Data Archiving', href: '/accounting/data-archiving' },
      ],
    },
    {
      section: 'Data Import',
      items: [
        { label: 'Import Transactions', href: '/accounting/gl-import' },
        { label: 'Migration Wizard', href: '/accounting/migration' },
        { label: 'Import from Xero / QuickBooks / Pastel', href: '/accounting/migration/external' },
        { label: 'Sage Migration', href: '/accounting/sage-migration' },
        { label: 'Bank Import', href: '/accounting/bank-reconciliation/import' },
      ],
    },
  ],
};

export const groupTab: Tab = {
  id: 'group', label: 'Group',
  items: [
    {
      section: 'Overview',
      items: [
        { label: 'Group Dashboard', href: '/accounting/group' },
        { label: 'Group Setup', href: '/accounting/group/setup' },
      ],
    },
    {
      section: 'Consolidated Reports',
      items: [
        { label: 'Consolidated Trial Balance', href: '/accounting/group/trial-balance' },
        { label: 'Consolidated Income Statement', href: '/accounting/group/income-statement' },
        { label: 'Consolidated Balance Sheet', href: '/accounting/group/balance-sheet' },
      ],
    },
    {
      section: 'Intercompany',
      items: [
        { label: 'Intercompany Reconciliation', href: '/accounting/group/intercompany' },
        { label: 'Elimination Adjustments', href: '/accounting/group/eliminations' },
      ],
    },
  ],
};
