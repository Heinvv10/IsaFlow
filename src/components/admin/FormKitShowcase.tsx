/**
 * FormKitShowcase — the "Form kit" section of the admin component library (/admin/components):
 * MoneyField, DateField, FormSection, AutosaveStatus, FieldHelp and ExplainDrawer.
 */

import { useState } from 'react';
import {
  Button, Input, MoneyField, DateField, FormSection, AutosaveStatus, ExplainDrawer,
  type AutosaveState, type Explanation,
} from '@/components/ui';
import { formatCentsEcho } from '@/lib/money/saAmountParser';

const EXPLANATION: Explanation = {
  title: 'How was PAYE calculated?',
  lines: [
    { label: 'Annual taxable income', formula: 'R 30 000.00 x 12', value: 'R 360 000.00', source: 'Payslip, gross pay' },
    { label: 'Tax on bracket', formula: '(360 000 - 237 100) x 26% + 42 678', value: 'R 74 634.00', source: 'SARS 2026/27 tables' },
    { label: 'Primary rebate', value: '-R 17 235.00', source: 'SARS 2026/27 tables' },
  ],
  caution: 'Medical aid credits are not included in this estimate.',
};

export function FormKitShowcase() {
  const [amount, setAmount] = useState<number | null>(2_500_000);
  const [date, setDate] = useState<string | null>(null);
  const [state, setState] = useState<AutosaveState>('saved');
  const [savedAt, setSavedAt] = useState<number>(() => Date.now());
  const [explain, setExplain] = useState(false);

  const touch = (): void => setState('dirty');
  const save = (): void => {
    setState('saving');
    setTimeout(() => {
      setSavedAt(Date.now());
      setState('saved');
    }, 800);
  };

  return (
    <section id="FormKit" className="scroll-mt-8 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Form kit</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          MoneyField, DateField, FormSection, AutosaveStatus, ExplainDrawer. Teal 3 px focus ring on both themes.
        </p>
      </div>
      <FormSection
        number={1}
        title="Invoice details"
        description="Type, do not pick. The field echoes what it understood."
        help={{ text: 'Dates and amounts are read once, when you leave the field.', href: 'https://help.isaflow.co.za/forms' }}
        status={<AutosaveStatus state={state} savedAt={savedAt} />}
        summary={
          <div className="rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-700">
            <p className="font-medium text-gray-900 dark:text-gray-100">Total due</p>
            <p className="mt-1 text-lg tabular-nums text-gray-900 dark:text-gray-100">
              {amount === null ? '—' : formatCentsEcho(amount)}
            </p>
          </div>
        }
      >
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <DateField
            label="Invoice date"
            value={date}
            onChange={(v) => { setDate(v); touch(); }}
            minDate="2026-03-01"
            minMessage="That date is in a locked period (before 01 Mar 2026)."
            helperText="Try t, +30, eom or 01/10/2026"
          />
          <MoneyField
            label="Amount"
            value={amount}
            onChange={(v) => { setAmount(v); touch(); }}
            helperText='Try "25 000,00" or "25,000.00"'
            help={{ text: 'The invoice total before any discount, in rand.' }}
          />
          <Input label="Reference" placeholder="INV-0001" onChange={touch} />
          <MoneyField label="Discount (invalid)" value={null} onChange={() => undefined} error="Discount cannot exceed the total." />
        </div>
        <div className="flex gap-3">
          <Button size="sm" onClick={save}>Save draft</Button>
          <Button size="sm" variant="secondary" onClick={() => setExplain(true)}>How was this calculated?</Button>
          <Button size="sm" variant="ghost" onClick={() => setState('error')}>Simulate save failure</Button>
        </div>
      </FormSection>

      <ExplainDrawer open={explain} onClose={() => setExplain(false)} explanation={EXPLANATION} />
    </section>
  );
}
