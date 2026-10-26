/**
 * Add or edit one account's budget for a financial year: an annual amount that
 * spreads evenly (cents on the last month) and one amount per month of the year,
 * so a 14-month transition year shows 14. The amounts are kit MoneyFields, held
 * here in integer cents: each is parsed on blur or Enter, so the annual amount
 * spreads when it is committed, not per keystroke, and a month edit resets the
 * annual amount to the sum. Text a field refuses ("1,234") blocks the save.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MoneyField } from '@/components/ui/MoneyField';
import type { FieldValidity } from '@/components/ui/useParsedField';
import { spreadEvenly } from '@/modules/accounting/services/core/budgetMonths';
import { monthLabel, type BudgetMonth, type GLAccount } from './budgetClient';

export interface BudgetSubmit {
  glAccountId: string; annualAmount: number; notes?: string; months?: BudgetMonth[];
}

interface Props {
  fiscalYear: number;
  monthKeys: string[];
  accounts: GLAccount[];
  /** Set when editing: the account is fixed and the months start from its stored amounts. */
  editing?: { glAccountId: string; months: BudgetMonth[]; notes?: string } | null;
  busy: boolean;
  onSubmit: (body: BudgetSubmit) => void;
  onCancel: () => void;
}

/** Stored rands (NUMERIC(15,2)) to cents; the product of a 2-dp value and 100 rounds back exactly. */
const toCents = (rands: number) => Math.round(Number(rands) * 100);
/** The kit's field-label style (FieldFrame), so the plain select and notes line up with the MoneyFields. */
const LABEL = 'text-sm font-medium text-gray-700 dark:text-gray-300';
const sumCents = (keys: string[], months: Record<string, number | null>) => keys.reduce((s, k) => s + (months[k] ?? 0), 0);

export function BudgetForm({ fiscalYear, monthKeys, accounts, editing, busy, onSubmit, onCancel }: Props) {
  const stored = new Map((editing?.months ?? []).map(m => [m.month, toCents(m.amount)]));
  const [glAccountId, setGlAccountId] = useState(editing?.glAccountId ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [months, setMonths] = useState<Record<string, number | null>>(
    () => Object.fromEntries(monthKeys.map(k => [k, stored.get(k) ?? null])));
  const [annual, setAnnual] = useState<number | null>(editing ? sumCents(monthKeys, Object.fromEntries(stored)) : null);
  /** The fields whose text was refused (`'annual'` or a month key): they hold null but are not empty. */
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');

  const mark = (next: Set<string>, key: string, validity: FieldValidity) => {
    if (validity.valid) next.delete(key); else next.add(key);
  };
  const spread = (cents: number | null, validity: FieldValidity) => {
    setAnnual(cents);
    setError('');
    const next = new Set(refused);
    mark(next, 'annual', validity);
    if (cents !== null && monthKeys.length > 0) {
      // spreadEvenly works in rands to 2 dp; cents / 100 is that value, and each part * 100 rounds back exactly.
      const parts = spreadEvenly(cents / 100, monthKeys.length).map(toCents);
      setMonths(Object.fromEntries(monthKeys.map((k, i) => [k, parts[i]!])));
      for (const k of monthKeys) next.delete(k);
    }
    setRefused(next);
  };
  const setMonth = (key: string, cents: number | null, validity: FieldValidity) => {
    const nextMonths = { ...months, [key]: cents };
    setMonths(nextMonths);
    setError('');
    const next = new Set(refused);
    mark(next, key, validity);
    // A refused month leaves the annual amount alone; a valid one replaces it with the sum, refused text included.
    if (validity.valid) {
      next.delete('annual');
      setAnnual(sumCents(monthKeys, nextMonths));
    }
    setRefused(next);
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const bad = monthKeys.find(k => refused.has(k));
    if (bad) { setError(`The amount for ${monthLabel(bad)} is not a valid amount`); return; }
    if (refused.has('annual') || annual === null) { setError('Enter a valid annual amount'); return; }
    onSubmit({
      glAccountId, annualAmount: annual / 100, notes: notes || undefined,
      months: monthKeys.length > 0 ? monthKeys.map(k => ({ month: k, amount: (months[k] ?? 0) / 100 })) : undefined,
    });
  };

  return (
    <form onSubmit={submit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
        {editing ? 'Edit' : 'Add'} Budget for {fiscalYear}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <div className="flex flex-col gap-1">
          <label htmlFor="budget-account" className={LABEL}>GL account</label>
          <select id="budget-account" value={glAccountId} onChange={e => setGlAccountId(e.target.value)} className="ff-select"
            required disabled={!!editing}>
            <option value="">Select GL Account *</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>)}
          </select>
        </div>
        <MoneyField label="Annual amount" value={annual} onChange={spread} required allowNegative />
        <div className="flex flex-col gap-1">
          <label htmlFor="budget-notes" className={LABEL}>Notes</label>
          <input id="budget-notes" value={notes} onChange={e => setNotes(e.target.value)} className="ff-input" placeholder="Optional" />
        </div>
      </div>
      {monthKeys.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {monthKeys.map(k => (
            <div key={k} data-testid={`budget-month-${k}`}>
              <MoneyField label={monthLabel(k)} value={months[k] ?? null} allowNegative
                onChange={(cents, validity) => setMonth(k, cents, validity)} />
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-[var(--ff-text-secondary)]">
        The annual amount is spread evenly across the {monthKeys.length || 12} months when you leave the field; edit a month to adjust it.
        A month left empty is saved as 0.
      </p>
      {error && <p role="alert" data-testid="budget-error" className="text-sm text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
        <button type="submit" disabled={busy} data-testid="budget-save"
          className="px-6 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Budget'}
        </button>
      </div>
    </form>
  );
}
