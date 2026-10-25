/**
 * VAT201 Summary view — the SARS form, field for field. Numbers, wording and
 * values all come from the server (`vat201SarsFields`); nothing is computed here.
 */

import { formatDate } from '@/utils/formatters';
import type { Vat201SarsField, Vat201SarsGroup } from '@/modules/accounting/services/reports/vat201SarsFields';
import { FormRow } from './VAT201FormSections';

interface Props {
  data: { periodStart: string; periodEnd: string; sarsFields: Vat201SarsField[] };
}

/** Heading printed above the first field of each group, as on the form. */
const GROUP_HEADINGS: Partial<Record<Vat201SarsGroup, { title: string; bg: string; text: string }>> = {
  'output-supplies': { title: 'A. Output tax — supply of goods and/or services by you', bg: 'bg-teal-500/5', text: 'text-teal-500' },
  'output-accommodation': { title: 'Supply of accommodation', bg: 'bg-teal-500/5', text: 'text-teal-500' },
  'output-adjustments': { title: 'Adjustments', bg: 'bg-teal-500/5', text: 'text-teal-500' },
  'input-supplies': { title: 'B. Input tax', bg: 'bg-blue-500/5', text: 'text-blue-500' },
  'input-adjustments': { title: 'Adjustments', bg: 'bg-blue-500/5', text: 'text-blue-500' },
};

const TOTAL_GROUPS: readonly Vat201SarsGroup[] = ['output-total', 'input-total', 'result'];

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export function VAT201SummaryForm({ data }: Props) {
  const result = data.sarsFields.find((f) => f.field === '20');
  return (
    <div data-testid="vat201-sars-form" className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
          VAT201 — {formatDate(data.periodStart)} to {formatDate(data.periodEnd)}
        </h2>
      </div>
      <div className="divide-y divide-[var(--ff-border-light)]">
        {data.sarsFields.map((f, i) => {
          const heading = GROUP_HEADINGS[f.group];
          const startsGroup = i === 0 || data.sarsFields[i - 1]!.group !== f.group;
          return (
            <div key={f.field}>
              {heading && startsGroup && (
                <div className={`px-4 py-2 ${heading.bg}`}>
                  <p className={`text-xs font-semibold uppercase tracking-wider ${heading.text}`}>{heading.title}</p>
                </div>
              )}
              <FormRow
                field={f.field} label={f.label} amount={f.amount} kind={f.kind} note={f.note}
                highlight={TOTAL_GROUPS.includes(f.group)}
              />
            </div>
          );
        })}
      </div>
      {result?.amount != null && (
        <div className="px-4 py-3 flex items-center justify-between border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/50">
          <span className="text-sm font-semibold text-[var(--ff-text-primary)]">
            {result.amount >= 0 ? 'VAT Payable to SARS' : 'VAT Refundable from SARS'}
          </span>
          <span className={`text-lg font-bold ${result.amount >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {fmt(Math.abs(result.amount))}
          </span>
        </div>
      )}
    </div>
  );
}
