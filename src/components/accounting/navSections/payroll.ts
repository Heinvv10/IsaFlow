import type { Tab } from './types';

/**
 * VIP-style mental model:
 *   • "Current Period" — daily payroll work for the open run.
 *   • "Employees" — the master roster + bulk admin actions.
 *   • "Reports" — statutory + operational read-only outputs.
 *   • "Setup" — rare configuration (components, leave types, period roll).
 *
 * isSetting=true marks items that belong in the "rare config" group at the
 * bottom of the dropdown (rendered with a gear icon + separator).
 */
export const payrollTab: Tab = {
  id: 'payroll', label: 'Payroll',
  topItems: [
    { label: 'New Payroll Run', href: '/payroll/runs/new' },
  ],
  items: [
    {
      section: 'Current Period',
      items: [
        { label: 'Payroll Runs',        href: '/payroll/runs' },
        { label: 'Batch Transactions',  href: '/payroll/batches' },
        { label: 'Employee Loans',      href: '/payroll/loans' },
        { label: 'Leave Capture',       href: '/payroll/leave/new' },
      ],
    },
    {
      section: 'Employees',
      items: [
        { label: 'Employees',           href: '/payroll/employees' },
        { label: 'Add Employee',        href: '/payroll/employees/new' },
        { label: 'Employee Duplicates', href: '/payroll/duplicates' },
      ],
    },
    {
      section: 'Reports',
      items: [
        { label: 'IRP5 Readiness',         href: '/payroll/irp5' },
        { label: 'EMP501 Reconciliation',  href: '/payroll/emp501' },
        { label: 'Tax Directives',         href: '/payroll/tax-directives' },
        { label: 'UIF Declarations',       href: '/payroll/uif' },
        { label: 'Year-End Workflow',      href: '/payroll/year-end' },
        { label: 'Compliance',             href: '/payroll/compliance' },
      ],
    },
    {
      section: 'Setup',
      items: [
        { label: 'Pay Components',   href: '/payroll/components',     isSetting: true },
        { label: 'Cost Centres',     href: '/payroll/cost-centres',   isSetting: true },
        { label: 'Leave Types',      href: '/payroll/leave/types',    isSetting: true },
        { label: 'Leave Balances',   href: '/payroll/leave/balances', isSetting: true },
      ],
    },
  ],
};
