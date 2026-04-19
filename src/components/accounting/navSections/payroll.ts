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
    {
      section: 'Leave',
      items: [
        { label: 'Leave Management', href: '/payroll/leave' },
        { label: 'Leave Balances', href: '/payroll/leave/balances' },
      ],
    },
    {
      section: 'Compliance',
      items: [
        { label: 'IRP5 Readiness', href: '/payroll/irp5' },
        { label: 'EMP501 Reconciliation', href: '/payroll/emp501' },
        { label: 'Tax Directives', href: '/payroll/tax-directives' },
      ],
    },
  ],
};
