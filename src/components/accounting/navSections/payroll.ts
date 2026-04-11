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
    {
      section: 'SARS Returns',
      items: [
        { label: 'EMP201 / SDL', href: '/payroll/emp201' },
        { label: 'IRP5 Certificates', href: '/payroll/irp5' },
        { label: 'UIF Declaration', href: '/payroll/uif' },
      ],
    },
  ],
};
