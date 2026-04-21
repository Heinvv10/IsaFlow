import type { Tab } from './types';

export const taxTab: Tab = {
  id: 'tax', label: 'Tax',
  items: [
    {
      section: 'VAT',
      items: [
        { label: 'VAT Return', href: '/accounting/reports/vat-return' },
        { label: 'VAT Reconciliation', href: '/accounting/reports/vat-reconciliation' },
        { label: 'VAT Adjustments', href: '/accounting/vat-adjustments' },
        { label: 'DRC VAT', href: '/accounting/drc-vat' },
      ],
    },
    {
      section: 'SARS Submissions',
      items: [
        { label: 'VAT201', href: '/accounting/sars/vat201' },
        { label: 'EMP201 Submission', href: '/accounting/sars/emp201' },
        { label: 'EMP201 / SDL (Payroll)', href: '/accounting/sars/emp201' },
        { label: 'Year-End Workflow', href: '/payroll/year-end' },
        { label: 'EMP501 Reconciliation', href: '/payroll/emp501' },
        { label: 'IRP5 Readiness', href: '/payroll/irp5' },
        { label: 'UIF Declaration', href: '/payroll/uif' },
        { label: 'Tax Directives', href: '/payroll/tax-directives' },
      ],
    },
    {
      section: 'Compliance',
      items: [
        { label: 'Compliance Calendar', href: '/accounting/sars' },
        { label: 'Submission History', href: '/accounting/sars/submissions' },
      ],
    },
    {
      section: 'Settings',
      items: [
        { label: 'VAT Settings', href: '/accounting/company-settings?tab=vat', isSetting: true },
      ],
    },
  ],
};
