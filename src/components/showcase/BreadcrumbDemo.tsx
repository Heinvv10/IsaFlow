/**
 * BreadcrumbDemo — showcase section for the Breadcrumb component.
 */

import { Breadcrumb } from '@/components/ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const FOUR_LEVELS = [
  { label: 'Accounting', href: '/accounting' },
  { label: 'Sales', href: '/accounting/customer-invoices' },
  { label: 'Invoice #INV-0042', href: '/accounting/customer-invoices/42' },
  { label: 'Edit' },
];

const DEEP_LEVELS = [
  { label: 'Home', href: '/' },
  { label: 'Accounting', href: '/accounting' },
  { label: 'Reports', href: '/accounting/reports' },
  { label: 'Sales by Customer', href: '/accounting/reports/sales-by-customer' },
  { label: 'Britech (Pty) Ltd' },
];

export function BreadcrumbDemo() {
  return (
    <div className="space-y-4">
      <Row label="4-level navigation">
        <Breadcrumb items={FOUR_LEVELS} />
      </Row>
      <Row label="Slash separator">
        <Breadcrumb items={FOUR_LEVELS} separator="slash" />
      </Row>
      <Row label="Responsive collapse (5 items, maxVisible=4 — click … to expand)">
        <Breadcrumb items={DEEP_LEVELS} maxVisible={4} />
      </Row>
    </div>
  );
}
