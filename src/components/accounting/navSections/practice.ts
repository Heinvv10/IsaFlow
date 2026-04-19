import type { Tab } from './types';

export const practiceTab: Tab = {
  id: 'practice',
  label: 'Practice',
  topItems: [
    { label: 'Add a Client', href: '/accounting/practice/clients/new' },
  ],
  items: [
    {
      section: 'Clients',
      items: [
        { label: 'Client List', href: '/accounting/practice/clients' },
        { label: 'Client Groups', href: '/accounting/practice/clients?view=groups' },
      ],
    },
    {
      section: 'Time Entry',
      items: [
        { label: 'Enter Time', href: '/accounting/practice/time-entry' },
        { label: 'Approvals', href: '/accounting/practice/approvals' },
        { label: 'My Timesheet', href: '/accounting/timesheets' },
      ],
    },
    {
      section: 'Jobs & Tasks',
      items: [
        { label: 'Jobs', href: '/accounting/practice/jobs' },
        { label: 'Tasks', href: '/accounting/practice/tasks' },
      ],
    },
    {
      section: 'WIP & Billing',
      items: [
        { label: 'WIP Board', href: '/accounting/practice/wip' },
        { label: 'Generate Invoice', href: '/accounting/practice/wip?action=invoice' },
      ],
    },
    {
      section: 'Admin',
      items: [
        { label: 'Job Categories', href: '/accounting/practice/job-categories' },
        { label: 'Staff Rates', href: '/accounting/practice/staff-rates' },
      ],
    },
    {
      section: 'Reports',
      items: [
        { label: 'Staff Utilisation', href: '/accounting/practice/reports/utilisation' },
        { label: 'Client Profitability', href: '/accounting/practice/reports/profitability' },
        { label: 'WIP Aging', href: '/accounting/practice/reports/wip-aging' },
      ],
    },
  ],
};
