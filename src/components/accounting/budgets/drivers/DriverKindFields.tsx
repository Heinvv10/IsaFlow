/**
 * The driver editor's fields for the picked kind (P4 spec §1.1): the amount (fixed, per head),
 * the percentage (of a line, of a section, growth a month), the line read (pct_of_line), the
 * section and its scope (pct_of_section), the growth base month, the headcount scope (per_head).
 * Each field carries its label and, when the draft refuses it, the message under it.
 */
import { useId, type ReactNode } from 'react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { BAND_LABEL, BAND_ORDER } from '@/modules/accounting/services/budgets/grid/subtotals';
import type { DraftField, DriverDraft } from './driverDraft';

export interface RowOption { key: string; label: string }
export interface ScopeOption { id: string; label: string }

export const INPUT = 'w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] disabled:opacity-60';

interface FieldProps { label: string; error?: string; hint?: string; children: (id: string, describedBy: string | undefined) => ReactNode }

export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const note = `${id}-note`;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-[var(--ff-text-secondary)]">{label}</label>
      {children(id, error || hint ? note : undefined)}
      {error ? <p id={note} className="text-xs text-error-700 dark:text-error-400">{error}</p>
        : hint ? <p id={note} className="text-xs text-[var(--ff-text-tertiary)]">{hint}</p> : null}
    </div>
  );
}

export interface DriverKindFieldsProps {
  draft: DriverDraft;
  errors: Partial<Record<DraftField, string>>;
  onChange(patch: Partial<DriverDraft>): void;
  months: readonly string[];
  /** Lines a pct_of_line driver may read (active non-header income-statement accounts at their grain; never the row itself). */
  rows: readonly RowOption[];
  costCentres: readonly ScopeOption[];
  disabled: boolean;
}

export function DriverKindFields({ draft, errors, onChange, months, rows, costCentres, disabled }: DriverKindFieldsProps) {
  const { kind } = draft;
  const money = kind === 'fixed' || kind === 'per_head';
  return (
    <div className="space-y-3">
      {money ? (
        <Field label={kind === 'fixed' ? 'Amount a month (R)' : 'Amount per head a month (R)'} error={errors.amount}>
          {(id, d) => <input id={id} aria-describedby={d} aria-invalid={errors.amount ? true : undefined} inputMode="decimal" className={INPUT}
            value={draft.amount} disabled={disabled} onChange={(e) => onChange({ amount: e.target.value })} />}
        </Field>
      ) : (
        <Field label={kind === 'growth' ? 'Growth a month (%)' : 'Percentage (%)'} error={errors.pct}
          hint={kind === 'growth' ? 'Compounds month on month; a negative figure shrinks.' : undefined}>
          {(id, d) => <input id={id} aria-describedby={d} aria-invalid={errors.pct ? true : undefined} inputMode="decimal" className={INPUT}
            value={draft.pct} disabled={disabled} onChange={(e) => onChange({ pct: e.target.value })} />}
        </Field>
      )}
      {kind === 'pct_of_line' && (
        <Field label="Of the line" error={errors.refRowKey}>
          {(id, d) => (
            <select id={id} aria-describedby={d} className={INPUT} value={draft.refRowKey} disabled={disabled}
              onChange={(e) => onChange({ refRowKey: e.target.value })}>
              <option value="">Pick a line…</option>
              {rows.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          )}
        </Field>
      )}
      {kind === 'pct_of_section' && (
        <>
          <Field label="Of the section">
            {(id) => (
              <select id={id} className={INPUT} value={draft.section} disabled={disabled}
                onChange={(e) => onChange({ section: e.target.value as DriverDraft['section'] })}>
                {BAND_ORDER.map((b) => <option key={b} value={b}>{BAND_LABEL[b]}</option>)}
              </select>
            )}
          </Field>
          <Field label="Section scope" hint="This row's level reads the section's rows at the same cost centre or business unit.">
            {(id, d) => (
              <select id={id} aria-describedby={d} className={INPUT} value={draft.scope} disabled={disabled}
                onChange={(e) => onChange({ scope: e.target.value as DriverDraft['scope'] })}>
                <option value="same_grain">This row&apos;s level</option>
                <option value="company">All levels (company total)</option>
              </select>
            )}
          </Field>
        </>
      )}
      {kind === 'growth' && (
        <Field label="Base month" error={errors.baseMonth} hint="The month whose amount the growth starts from.">
          {(id, d) => (
            <select id={id} aria-describedby={d} className={INPUT} value={draft.baseMonth} disabled={disabled}
              onChange={(e) => onChange({ baseMonth: e.target.value })}>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          )}
        </Field>
      )}
      {kind === 'per_head' && (
        <Field label="Headcount of" hint="Payroll actives plus the version's planned hires, per month.">
          {(id, d) => (
            <select id={id} aria-describedby={d} className={INPUT} value={draft.headcountScope} disabled={disabled}
              onChange={(e) => onChange({ headcountScope: e.target.value })}>
              <option value="">The whole company</option>
              {costCentres.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          )}
        </Field>
      )}
    </div>
  );
}
