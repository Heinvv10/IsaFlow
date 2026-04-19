import type { Tab } from './types';

export const payrollTab: Tab = {
  id: 'payroll', label: 'Payroll',
  topItems: [
    { label: 'New Payroll Run', href: '/payroll/runs/new' },
  ],
  items: [
    {
      section: 'Employees',
      items: [
        { label: 'Employees', href: '/payroll/employees' },
        { label: 'Pay Components', href: '/payroll/components' },
      ],
    },
    {
      section: 'Processing',
      items: [
        { label: 'Payroll Runs', href: '/payroll/runs' },
      ],
    },
  ],
};
