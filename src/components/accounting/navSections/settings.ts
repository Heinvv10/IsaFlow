import type { Tab } from './types';

export const settingsTab: Tab = {
  id: 'settings', label: 'Settings',
  items: [
    {
      section: 'Company',
      items: [
        { label: 'Company Settings', href: '/accounting/company-settings', isSetting: true },
        { label: 'User Access', href: '/accounting/user-access', isSetting: true },
        { label: 'My Account', href: '/accounting/my-account', isSetting: true },
      ],
    },
    {
      section: 'Documents & Workflows',
      items: [
        { label: 'Document Capture', href: '/accounting/document-capture' },
        { label: 'Approvals', href: '/accounting/approvals' },
        { label: 'Recurring Transactions', href: '/accounting/recurring-transactions' },
        { label: 'Webhooks', href: '/accounting/webhooks' },
      ],
    },
    {
      section: 'Productivity',
      items: [
        { label: 'Time Tracking', href: '/accounting/time-tracking' },
        { label: 'Timesheets (Week View)', href: '/accounting/timesheets' },
      ],
    },
    {
      section: 'Data Quality',
      items: [
        { label: 'Duplicate Detection', href: '/accounting/duplicates' },
        { label: 'Data Archiving', href: '/accounting/data-archiving' },
      ],
    },
    {
      section: 'Data Import',
      items: [
        { label: 'Migration Wizard', href: '/accounting/migration' },
        { label: 'Import Transactions', href: '/accounting/gl-import' },
        { label: 'Import from Xero / QuickBooks / Pastel', href: '/accounting/migration/external' },
        { label: 'Sage Migration', href: '/accounting/sage-migration' },
        { label: 'Bank Import', href: '/accounting/bank-reconciliation/import' },
      ],
    },
    {
      section: 'Developer',
      items: [
        { label: 'Personal Access Tokens', href: '/developer/personal-tokens' },
        { label: 'OAuth Apps', href: '/developer/oauth-apps' },
        { label: 'Connected Apps', href: '/accounting/settings/connected-apps' },
        { label: 'MCP Connector (AI agents)', href: '/accounting/settings/integrations-mcp' },
      ],
    },
    {
      section: 'Group Consolidation',
      items: [
        { label: 'Group Dashboard', href: '/accounting/group' },
        { label: 'Group Setup', href: '/accounting/group/setup' },
        { label: 'Consolidated Trial Balance', href: '/accounting/group/trial-balance' },
        { label: 'Consolidated Income Statement', href: '/accounting/group/income-statement' },
        { label: 'Consolidated Balance Sheet', href: '/accounting/group/balance-sheet' },
        { label: 'Intercompany Reconciliation', href: '/accounting/group/intercompany' },
        { label: 'Elimination Adjustments', href: '/accounting/group/eliminations' },
        { label: 'Group Consolidation', href: '/accounting/consolidation' },
      ],
    },
  ],
};
