/**
 * Add or edit one account's budget for a financial year: an annual amount that
 * spreads evenly (cents on the last month) and one input per month of the year,
 * so a 14-month transition year shows 14 inputs. Typing in a month updates the
 * annual amount to the sum.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { round2, spreadEvenly } from '@/modules/accounting/services/core/budgetMonths';
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

/** An empty or blank field is 0 (Number('') is 0); anything else must be a finite number (null when it is not). */
function parseAmount(value = ''): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const sum = (values: string[]) => round2(values.reduce((s, v) => s + (parseAmount(v) ?? 0), 0));

export function BudgetForm({ fiscalYear, monthKeys, accounts, editing, busy, onSubmit, onCancel }: Props) {
  const stored = new Map((editing?.months ?? []).map(m => [m.month, String(m.amount)]));
  const [glAccountId, setGlAccountId] = useState(editing?.glAccountId ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [months, setMonths] = useState<Record<string, string>>(
    Object.fromEntries(monthKeys.map(k => [k, stored.get(k) ?? ''])));
  const [annual, setAnnual] = useState(editing ? String(sum([...stored.values()])) : '');
  const [error, setError] = useState('');

  const spread = (value: string) => {
    setAnnual(value);
    setError('');
    if (monthKeys.length === 0 || value === '' || !Number.isFinite(Number(value))) return;
    const parts = spreadEvenly(Number(value), monthKeys.length);
    setMonths(Object.fromEntries(monthKeys.map((k, i) => [k, String(parts[i])])));
  };
  const setMonth = (key: string, value: string) => {
    const next = { ...months, [key]: value };
    setMonths(next);
    setError('');
    setAnnual(String(sum(monthKeys.map(k => next[k] ?? ''))));
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = monthKeys.map(k => ({ month: k, amount: parseAmount(months[k]) }));
    const bad = parsed.find(m => m.amount === null);
    if (bad) { setError(`The amount for ${monthLabel(bad.month)} must be a number`); return; }
    const annualAmount = parseAmount(annual);
    if (annualAmount === null) { setError('The annual amount must be a number'); return; }
    onSubmit({
      glAccountId, annualAmount, notes: notes || undefined,
      months: monthKeys.length > 0 ? parsed.map(m => ({ month: m.month, amount: m.amount ?? 0 })) : undefined,
    });
  };

  return (
    <form onSubmit={submit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
        {editing ? 'Edit' : 'Add'} Budget for {fiscalYear}
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <select value={glAccountId} onChange={e => setGlAccountId(e.target.value)} className="ff-select"
          required disabled={!!editing}>
          <option value="">Select GL Account *</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>)}
        </select>
        <input type="number" step="0.01" value={annual} onChange={e => spread(e.target.value)}
          className="ff-input" placeholder="Annual Amount *" aria-label="Annual amount" required />
        <input value={notes} onChange={e => setNotes(e.target.value)} className="ff-input" placeholder="Notes (optional)" aria-label="Notes" />
      </div>
      {monthKeys.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {monthKeys.map(k => (
            <label key={k} className="text-xs text-[var(--ff-text-secondary)] space-y-1">
              <span>{monthLabel(k)}</span>
              <input type="number" step="0.01" data-testid={`budget-month-${k}`} value={months[k] ?? ''}
                onChange={e => setMonth(k, e.target.value)} className="ff-input w-full" />
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-[var(--ff-text-secondary)]">
        The annual amount is spread evenly across the {monthKeys.length || 12} months; edit a month to adjust it.
        A month left empty is saved as 0.
      </p>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
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
