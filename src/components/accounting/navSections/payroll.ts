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
        { label: 'Leave', href: '/payroll/leave' },
      ],
    },
    {
      section: 'Compliance',
      items: [
        { label: 'IRP5 Readiness', href: '/payroll/irp5-readiness' },
        { label: 'EMP501', href: '/payroll/emp501' },
      ],
    },
  ],
};
