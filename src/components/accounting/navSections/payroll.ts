import type { Tab } from './types';

export const payrollTab: Tab = {
  id: 'payroll', label: 'Payroll',
  items: [
    {
      section: 'Lists',
      items: [
        { label: 'Employees', href: '/payroll/employees' },
      ],
    },
    {
      section: 'Processing',
      items: [
        { label: 'Payroll Runs', href: '/payroll/runs' },
        { label: 'New Payroll Run', href: '/payroll/runs/new' },
      ],
    },
    {
      section: 'Leave',
      items: [
        { label: 'Leave Applications', href: '/payroll/leave' },
      ],
    },
  ],
};
