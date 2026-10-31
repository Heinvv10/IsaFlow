/**
 * The headcount panel (P4 decision 7, spec §7): per month of the version, payroll actives,
 * planned hires and their total, for the company or one cost centre, with the "as of" stamp of
 * the payroll read and "Refresh headcount" (a recompute of the per_head drivers). COUNTS ONLY:
 * the route answers no names, ID numbers or pay, and nothing here asks for them. The version's
 * planned hires are edited inline below the counts (`PlannedHires`). Every write goes through
 * the workspace's driver write path (token sent and adopted, grid reloaded); the panel then reads
 * the counts and hires again. A budget reader gets no counts (perHeadAccess, POPIA): the panel says
 * so in place of the table.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { failureText } from '@/components/accounting/budgets/workspace/failureText';
import {
  deleteHire, fetchHeadcount, listHires, refreshHeadcount, saveHire, type RestrictedHeadcount, type StoredPlannedHire, type VersionHeadcount,
} from './driverClient';
import { PER_HEAD_RESTRICTED_NOTE } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import type { ScopeOption } from './DriverKindFields';
import { PlannedHires, type HireInput } from './PlannedHires';
import type { DriverActions } from './useDriverActions';

export interface HeadcountPanelProps {
  versionId: string;
  months: readonly string[];
  costCentres: readonly ScopeOption[];
  /** A writer on an unlocked version. */
  editable: boolean;
  runWrite: DriverActions['runWrite'];
  /** A hire or refresh changed the counts: the editor preview's cache is stale. */
  onCountsChanged(): void;
}

const count = (n: number) => String(Number(n.toFixed(2)));
const stamp = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const SELECT = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]';
const ROWS: ReadonlyArray<{ key: 'payroll' | 'hires' | 'total'; label: string }> = [
  { key: 'payroll', label: 'Payroll actives' }, { key: 'hires', label: 'Planned hires' }, { key: 'total', label: 'Total' },
];

export function HeadcountPanel({ versionId, months, costCentres, editable, runWrite, onCountsChanged }: HeadcountPanelProps) {
  const [scope, setScope] = useState('');
  const [answer, setAnswer] = useState<VersionHeadcount | RestrictedHeadcount | null>(null);
  const counts = answer && 'months' in answer ? answer : null;
  const restricted = answer !== null && 'perHeadRestricted' in answer;
  const [hires, setHires] = useState<StoredPlannedHire[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let gone = false;
    void Promise.all([fetchHeadcount(versionId, scope === '' ? null : scope), listHires(versionId)]).then(([c, h]) => {
      if (gone) return;
      if (c.ok) setAnswer(c.data);
      if (h.ok) setHires(h.data.hires);
      // A good read clears an earlier failure; a failed one says which.
      setError(!c.ok ? failureText(c) : !h.ok ? failureText(h) : null);
    });
    return () => { gone = true; };
  }, [versionId, scope, bump]);

  const changed = useCallback(() => { onCountsChanged(); setBump((n) => n + 1); }, [onCountsChanged]);
  const write = useCallback(async (fn: Parameters<DriverActions['runWrite']>[0], done: string): Promise<string | null> => {
    const f = await runWrite(fn, (d) => `${done}; ${d.recomputed} cell${d.recomputed === 1 ? '' : 's'} recomputed`);
    if (f) {
      // A refused write (a hire someone else deleted, a stale token) may leave the list behind the server: read it again.
      setBump((n) => n + 1);
      return f.message;
    }
    changed();
    return null;
  }, [runWrite, changed]);

  const refresh = async () => {
    setBusy(true);
    try {
      setError(await write((v, t) => refreshHeadcount(v, t), 'Headcount refreshed'));
    } finally {
      setBusy(false);
    }
  };
  const onSave = (h: HireInput) => write((v, t) => saveHire(v, t, h), h.id ? 'Planned hire saved' : 'Planned hire added');
  const onDelete = (id: string) => write((v, t) => deleteHire(v, t, id), 'Planned hire deleted');

  return (
    <section aria-labelledby="headcount-title" data-testid="headcount-panel"
      className="space-y-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="headcount-title" className="mr-auto text-base font-semibold text-[var(--ff-text-primary)]">Headcount</h2>
        <select aria-label="Headcount of" className={SELECT} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">The whole company</option>
          {costCentres.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        {editable && (
          <button type="button" onClick={() => { void refresh(); }} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}Refresh headcount
          </button>
        )}
      </div>
      {restricted ? (
        <p className="text-xs text-[var(--ff-text-tertiary)]" data-testid="headcount-restricted">{PER_HEAD_RESTRICTED_NOTE}</p>
      ) : (
        <p className="text-xs text-[var(--ff-text-tertiary)]" data-testid="headcount-as-of">
          Counts only: payroll actives are read from payroll (never names or pay){counts ? `; as of ${stamp(counts.asOf)}` : ''}.
          Payroll changes reach the per-head drivers when you refresh.
        </p>
      )}
      {error && <p role="alert" className="text-sm text-error-700 dark:text-error-400">{error}</p>}
      {counts && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs" data-testid="headcount-table">
            <thead>
              <tr>
                <th scope="col" className="px-2 py-1 text-left font-medium text-[var(--ff-text-secondary)]">Heads</th>
                {counts.months.map((m) => <th key={m.month} scope="col" className="px-2 py-1 text-right font-medium text-[var(--ff-text-secondary)]">{monthLabel(m.month).slice(0, 3)}</th>)}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.key} className={r.key === 'total' ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}>
                  <th scope="row" className="whitespace-nowrap px-2 py-1 text-left font-normal">{r.label}</th>
                  {counts.months.map((m) => <td key={m.month} className="px-2 py-1 text-right tabular-nums">{count(m[r.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PlannedHires hires={hires} months={months} costCentres={costCentres} editable={editable} onSave={onSave} onDelete={onDelete} />
    </section>
  );
}
