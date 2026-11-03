/**
 * Per-account (or per-slice) alert thresholds (budgets P5-4, decision 9). The most specific wins:
 * an account + slice override, then the account's, then the company default. Owners and admins add,
 * replace (same account and slice) and remove; a manager reads. Expense accounts only.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { parseThresholds, type ControlsView, type OverrideDraft } from './controlsClient';

const PANEL = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4';
const INPUT = 'w-full min-w-0 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] disabled:opacity-60';
const BTN = 'inline-flex items-center gap-1.5 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';

type SliceKind = '' | 'cc1' | 'cc2' | 'bu';

export interface ThresholdOverridesProps {
  view: ControlsView;
  canEdit: boolean;
  busy: boolean;
  onAdd: (draft: OverrideDraft) => Promise<boolean>;
  onRemove: (id: string) => Promise<void>;
}

export function ThresholdOverrides({ view, canEdit, busy, onAdd, onRemove }: ThresholdOverridesProps) {
  const { overrides, options } = view;
  const [account, setAccount] = useState('');
  const [kind, setKind] = useState<SliceKind>('');
  const [member, setMember] = useState('');
  const [values, setValues] = useState('');
  const [problem, setProblem] = useState('');
  const members = kind === 'cc1' ? options.cc1 : kind === 'cc2' ? options.cc2 : kind === 'bu' ? options.units : [];

  const add = async () => {
    const parsed = parseThresholds(values);
    if (!account) { setProblem('Choose an expense account.'); return; }
    if (kind && !member) { setProblem('Choose the slice, or set "Whole account".'); return; }
    if (!parsed.ok) { setProblem(parsed.message); return; }
    setProblem('');
    const ok = await onAdd({
      glAccountId: account, cc1Id: kind === 'cc1' ? member : null, cc2Id: kind === 'cc2' ? member : null, buId: kind === 'bu' ? member : null,
      thresholds: parsed.values,
    });
    if (ok) { setValues(''); setMember(''); }
  };

  return (
    <section className={PANEL} aria-labelledby="budget-overrides-heading" data-testid="budget-overrides">
      <h2 id="budget-overrides-heading" className="text-base font-semibold text-[var(--ff-text-primary)]">Thresholds per account</h2>
      <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">
        An account, or one cost centre or business unit of it, can have its own thresholds instead of the defaults.
      </p>
      {overrides.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--ff-text-secondary)]" data-testid="budget-overrides-empty">No overrides: every account uses the default thresholds.</p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--ff-border-light)]">
          {overrides.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="min-w-0 break-words text-[var(--ff-text-primary)]">
                {o.accountCode} {o.accountName}
                <span className="text-[var(--ff-text-secondary)]"> · {o.sliceName ?? 'whole account'}</span>
              </span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-[var(--ff-text-primary)]">{o.thresholds.map((t) => `${t}%`).join(', ')}</span>
                {canEdit && (
                  <button type="button" className={BTN} disabled={busy} onClick={() => void onRemove(o.id)}
                    aria-label={`Remove the thresholds of ${o.accountCode} ${o.sliceName ?? 'whole account'}`}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          <label className="min-w-0 text-sm text-[var(--ff-text-primary)] lg:col-span-2">Expense account
            <select className={`${INPUT} mt-1`} value={account} disabled={busy} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Choose…</option>
              {options.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-sm text-[var(--ff-text-primary)]">Applies to
            <select className={`${INPUT} mt-1`} value={kind} disabled={busy} onChange={(e) => { setKind(e.target.value as SliceKind); setMember(''); }}>
              <option value="">Whole account</option>
              {options.cc1.length > 0 && <option value="cc1">One CC1 cost centre</option>}
              {options.cc2.length > 0 && <option value="cc2">One CC2 cost centre</option>}
              {options.units.length > 0 && <option value="bu">One business unit</option>}
            </select>
          </label>
          {kind !== '' && (
            <label className="min-w-0 text-sm text-[var(--ff-text-primary)]">Slice
              <select className={`${INPUT} mt-1`} value={member} disabled={busy} onChange={(e) => setMember(e.target.value)}>
                <option value="">Choose…</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.code} {m.name}</option>)}
              </select>
            </label>
          )}
          <label className="min-w-0 text-sm text-[var(--ff-text-primary)]">Thresholds (%)
            <input className={`${INPUT} mt-1`} value={values} disabled={busy} placeholder="e.g. 90, 110" inputMode="numeric"
              onChange={(e) => setValues(e.target.value)} />
          </label>
          <div>
            <button type="button" className={BTN} disabled={busy} onClick={() => void add()} data-testid="budget-override-add">
              <Plus className="h-4 w-4" aria-hidden /> Save override
            </button>
          </div>
        </div>
      )}
      {problem && <p role="alert" className="mt-2 text-sm text-error-700 dark:text-error-400">{problem}</p>}
    </section>
  );
}
