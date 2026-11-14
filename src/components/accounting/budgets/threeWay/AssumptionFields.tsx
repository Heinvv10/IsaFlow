/**
 * One assumption scalar (budgets P6 spec §8): its input, the source chip (Derived / Manual) and the derive
 * evidence (the derived value and its basis, the as-at). A manual value offers "Use derived". Read-only when the
 * version is locked. Also the payable-account picker (§13 PR C: a LEAF liability of the company, or the
 * synthetic line).
 */
import { useState } from 'react';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { displayValue, getProv, parseInput, setManual, withDerived, type ProvField } from './assumptionsModel';
import type { LiabilityOption } from './useAssumptionsForm';

export const INPUT = 'w-full min-w-0 rounded-md border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-2 py-1 text-sm text-[var(--ff-text-primary)] disabled:opacity-60';
const CHIP = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';

type Doc = ThreeWayAssumptions;

/**
 * A number input that keeps what is typed ("0.", "-") while the field has focus and reports each parseable value;
 * on blur it shows the document's value again.
 */
export function NumberInput({ value, onValue, id, label, disabled, min, max }: {
  value: string; onValue: (raw: string) => void; id?: string; label?: string; disabled: boolean; min?: number; max?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input id={id} aria-label={label} className={`${INPUT} text-right tabular-nums`} type="number" inputMode="decimal" step="any"
      disabled={disabled} min={min} max={max} value={draft ?? value}
      onChange={(e) => { setDraft(e.target.value); onValue(e.target.value); }} onBlur={() => setDraft(null)} />
  );
}

export interface ProvFieldRowProps {
  field: ProvField;
  doc: Doc;
  derived: Doc;
  readOnly: boolean;
  onChange: (next: (d: Doc) => Doc) => void;
}

export function ProvFieldRow({ field, doc, derived, readOnly, onChange }: ProvFieldRowProps) {
  const prov = getProv(doc, field);
  const der = getProv(derived, field);
  const id = `tw-${field.path.replace(/\./g, '-')}`;
  const manual = prov.source === 'manual';
  const set = (raw: string) => {
    const v = parseInput(field, raw);
    if (v !== null) onChange((d) => setManual(d, field, v));
  };
  const derivedText = field.kind === 'bool' ? (der.value ? 'yes' : 'no') : (field.choices?.find((c) => c.value === der.value)?.label ?? displayValue(field, der.value));
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,10rem)_1fr] sm:items-start sm:gap-3" data-field={field.path}>
      <label htmlFor={id} className="text-sm text-[var(--ff-text-primary)]">{field.label}</label>
      <div>
        {field.kind === 'bool' ? (
          <select id={id} className={INPUT} disabled={readOnly} value={String(prov.value)} onChange={(e) => set(e.target.value)}>
            <option value="true">Yes</option><option value="false">No</option>
          </select>
        ) : field.choices ? (
          <select id={id} className={INPUT} disabled={readOnly} value={String(prov.value)} onChange={(e) => set(e.target.value)}>
            {field.choices.map((c) => <option key={String(c.value)} value={String(c.value)}>{c.label}</option>)}
          </select>
        ) : (
          <NumberInput id={id} disabled={readOnly} value={displayValue(field, prov.value)} onValue={set}
            min={field.kind === 'money' ? undefined : 0} max={field.kind === 'percent' ? 100 : field.max} />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ff-text-secondary)]">
        <span data-testid={`source-chip-${field.path}`}
          className={`${CHIP} ${manual ? 'border-[var(--ff-text-secondary)] text-[var(--ff-text-primary)]' : 'border-[var(--ff-border-light)]'}`}>
          {manual ? 'Manual' : 'Derived'}
        </span>
        <span>
          Derived {derivedText}{der.basis ? ` · ${der.basis}` : ''}{der.derivedAsAt ? ` (as at ${der.derivedAsAt})` : ''}
        </span>
        {manual && !readOnly && (
          <button type="button" className="underline hover:text-[var(--ff-text-primary)]" onClick={() => onChange((d) => withDerived(d, derived, field))}>
            Use derived
          </button>
        )}
      </div>
    </div>
  );
}

export interface PayablePickerProps {
  label: string;
  value: string | undefined;
  accounts: readonly LiabilityOption[];
  evidence: string;
  readOnly: boolean;
  onChange: (id: string | undefined) => void;
  /** The server's 400 message for this slot (a refused save names its path). */
  issue?: string | null;
  testId?: string;
}

export function PayablePicker({ label, value, accounts, evidence, readOnly, onChange, issue, testId }: PayablePickerProps) {
  const id = `tw-payable-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const known = value === undefined || accounts.some((a) => a.id === value);
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,16rem)_1fr] sm:items-start sm:gap-3">
      <label htmlFor={id} className="text-sm text-[var(--ff-text-primary)]">{label}</label>
      <select id={id} className={INPUT} disabled={readOnly} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
        <option value="">None (a budget-only line, opening 0)</option>
        {!known && <option value={value}>{value}</option>}
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountCode} {a.accountName}</option>)}
      </select>
      <div className="text-xs">
        <p className="text-[var(--ff-text-secondary)]">{evidence} Only accounts that would otherwise sit in other liabilities are listed.</p>
        {issue && <p role="alert" data-testid={testId} className="text-error-700 dark:text-error-400">{issue}</p>}
      </div>
    </div>
  );
}
