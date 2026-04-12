/**
 * AgingTab — configure aging/ageing basis, period type, and bucket thresholds.
 * Uses the company row columns: aging_basis, aging_period_type, aging_bucket1/2/3_days.
 * The existing ageingMonthly / ageingBasedOn toggles live in GeneralTab — this tab
 * exposes the finer-grained numeric bucket config.
 */

import { BarChart2 } from 'lucide-react';
import { Company, INPUT_CLS, LABEL_CLS, SECTION_CLS } from './settingsTypes';

interface Props {
  company: Company;
  onChange: (field: keyof Company, value: unknown) => void;
}

const RadioGroup = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; description?: string }[];
  onChange: (v: string) => void;
}) => (
  <div>
    <p className={LABEL_CLS}>{label}</p>
    <div className="flex flex-col gap-2 mt-1">
      {options.map(opt => (
        <label key={opt.value} className="flex items-start gap-3 cursor-pointer">
          <input
            type="radio"
            name={label}
            value={opt.value}
            checked={value === opt.value}
            onChange={() => onChange(opt.value)}
            className="mt-0.5 accent-teal-500"
          />
          <span>
            <span className="text-sm text-[var(--ff-text-primary)]">{opt.label}</span>
            {opt.description && (
              <span className="block text-xs text-[var(--ff-text-tertiary)]">{opt.description}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  </div>
);

export function AgingTab({ company, onChange }: Props) {
  const byDays = company.agingPeriodType === 'days';

  return (
    <>
      {/* Aging Basis */}
      <section className={SECTION_CLS}>
        <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4 flex items-center gap-2">
          <BarChart2 className="h-5 w-5" /> Aging Configuration
        </h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mb-6">
          Controls how outstanding customer and supplier balances are bucketed in age analysis reports.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <RadioGroup
            label="Calculate Aging From"
            value={company.agingBasis}
            onChange={v => onChange('agingBasis', v)}
            options={[
              {
                value: 'due_date',
                label: 'Due Date',
                description: 'Age from the payment due date on the document.',
              },
              {
                value: 'invoice_date',
                label: 'Invoice / Document Date',
                description: 'Age from the date the document was raised.',
              },
            ]}
          />

          <RadioGroup
            label="Aging Period Type"
            value={company.agingPeriodType}
            onChange={v => onChange('agingPeriodType', v)}
            options={[
              {
                value: 'monthly',
                label: 'Monthly',
                description: 'Group by calendar month (current month, 1 month, 2 months…).',
              },
              {
                value: 'days',
                label: 'By Days',
                description: 'Group by configurable day thresholds below.',
              },
            ]}
          />
        </div>
      </section>

      {/* Bucket thresholds — only when "By Days" */}
      {byDays && (
        <section className={SECTION_CLS}>
          <h2 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-1">Day Bucket Thresholds</h2>
          <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
            Invoices aged beyond each threshold move to the next bucket. The final bucket captures
            anything beyond the third threshold.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-lg">
            <div>
              <label className={LABEL_CLS}>Bucket 1 (days)</label>
              <input
                type="number"
                min={1}
                max={999}
                className={INPUT_CLS}
                value={company.agingBucket1Days}
                onChange={e => onChange('agingBucket1Days', Number(e.target.value))}
              />
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">e.g. 30 = &quot;0–30 days&quot;</p>
            </div>
            <div>
              <label className={LABEL_CLS}>Bucket 2 (days)</label>
              <input
                type="number"
                min={1}
                max={999}
                className={INPUT_CLS}
                value={company.agingBucket2Days}
                onChange={e => onChange('agingBucket2Days', Number(e.target.value))}
              />
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">e.g. 60 = &quot;31–60 days&quot;</p>
            </div>
            <div>
              <label className={LABEL_CLS}>Bucket 3 (days)</label>
              <input
                type="number"
                min={1}
                max={999}
                className={INPUT_CLS}
                value={company.agingBucket3Days}
                onChange={e => onChange('agingBucket3Days', Number(e.target.value))}
              />
              <p className="text-xs text-[var(--ff-text-tertiary)] mt-1">e.g. 90 = &quot;61–90 days&quot;</p>
            </div>
          </div>

          {/* Preview */}
          <div className="mt-4 p-3 rounded-lg bg-teal-500/5 border border-teal-500/20">
            <p className="text-xs font-medium text-teal-400 mb-1">Bucket preview</p>
            <div className="flex flex-wrap gap-2 text-xs text-[var(--ff-text-secondary)]">
              <span className="px-2 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)]">
                Current (0–{company.agingBucket1Days} days)
              </span>
              <span className="px-2 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)]">
                {company.agingBucket1Days + 1}–{company.agingBucket2Days} days
              </span>
              <span className="px-2 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)]">
                {company.agingBucket2Days + 1}–{company.agingBucket3Days} days
              </span>
              <span className="px-2 py-0.5 rounded bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)]">
                {company.agingBucket3Days + 1}+ days
              </span>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
