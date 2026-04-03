/**
 * TabsDemo — showcase section for the Tabs component.
 */

import { useState } from 'react';
import { FileText, CheckCircle, Clock } from 'lucide-react';
import { Tabs } from '@/components/ui';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      {children}
    </div>
  );
}

const UNDERLINE_TABS = [
  { id: 'all', label: 'All Invoices', count: 87, icon: FileText },
  { id: 'paid', label: 'Paid', count: 54, icon: CheckCircle },
  { id: 'pending', label: 'Pending', count: 29, icon: Clock },
  { id: 'overdue', label: 'Overdue', count: 4 },
];

const PILL_TABS = [
  { id: 'month', label: 'This Month' },
  { id: 'quarter', label: 'This Quarter' },
  { id: 'year', label: 'This Year' },
  { id: 'custom', label: 'Custom', disabled: true },
];

export function TabsDemo() {
  const [underlineTab, setUnderlineTab] = useState('all');
  const [pillTab, setPillTab] = useState('month');

  return (
    <div className="space-y-6">
      <Row label="Underline variant with icons and count badges">
        <Tabs
          tabs={UNDERLINE_TABS}
          activeTab={underlineTab}
          onChange={setUnderlineTab}
          variant="underline"
          aria-label="Invoice status tabs"
        />
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Active tab: <strong className="text-gray-700 dark:text-gray-300">{underlineTab}</strong>
        </p>
      </Row>

      <Row label="Pill variant with disabled tab">
        <Tabs
          tabs={PILL_TABS}
          activeTab={pillTab}
          onChange={setPillTab}
          variant="pill"
          aria-label="Date range tabs"
        />
      </Row>
    </div>
  );
}
