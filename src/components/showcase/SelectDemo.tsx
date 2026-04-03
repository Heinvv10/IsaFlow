/**
 * SelectDemo — showcase section for the Select component.
 */

import { useState } from 'react';
import { Select, type SelectOption } from '@/components/ui';

const ACCOUNT_OPTIONS: SelectOption[] = [
  { value: 'acc-4000', label: 'Sales Revenue (4000)' },
  { value: 'acc-4100', label: 'Service Income (4100)' },
  { value: 'acc-5000', label: 'Cost of Goods Sold (5000)' },
  { value: 'acc-6000', label: 'Payroll Expenses (6000)' },
  { value: 'acc-6100', label: 'Rent & Facilities (6100)' },
  { value: 'acc-6200', label: 'Travel & Entertainment (6200)' },
  { value: 'acc-7000', label: 'Depreciation (7000)', disabled: true },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {label}
      </p>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

export function SelectDemo() {
  const [singleValue, setSingleValue] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState<string | null>(null);
  const [multiValue, setMultiValue] = useState<string[]>([]);

  return (
    <div className="space-y-6">
      <Row label="Single select">
        <Select
          label="Ledger Account"
          options={ACCOUNT_OPTIONS}
          value={singleValue}
          onChange={setSingleValue}
          placeholder="Choose account…"
          clearable
        />
      </Row>

      <Row label="Searchable single select">
        <Select
          label="Searchable Account"
          options={ACCOUNT_OPTIONS}
          value={searchValue}
          onChange={setSearchValue}
          placeholder="Search and select…"
          searchable
          clearable
        />
      </Row>

      <Row label="Multi-select">
        <Select
          label="Tag Accounts"
          options={ACCOUNT_OPTIONS}
          value={multiValue}
          onChange={setMultiValue}
          placeholder="Select multiple…"
          multiple
          clearable
        />
        {multiValue.length > 0 && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            Selected: {multiValue.join(', ')}
          </p>
        )}
      </Row>

      <Row label="With error state">
        <Select
          label="Required Account"
          options={ACCOUNT_OPTIONS}
          value={null}
          onChange={() => undefined}
          error="Please select a ledger account."
        />
      </Row>
    </div>
  );
}
