/**
 * A bonus run's amounts, with a correction (wave 6 OC, review #1620 final breaker M). An owner or admin changes an
 * amount on a draft or calculated bonus run (a paid run is reopened first, which is allowed until its month's EMP201
 * is filed); the run goes back to draft and is recalculated. Recovering cash already paid happens outside payroll.
 * Renders nothing for any other run.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { FocusedAlert } from '@/components/ui/FocusedAlert';
import { formatCurrency } from '@/utils/formatters';

interface Input { employeeId: string; employeeName: string; amount: number }
interface Props {
  runId: string;
  run: { runKind?: string; offCycleReason?: string | null; status: string };
  companyRole: string | null | undefined;
  onChanged: () => void;
}

export function OffCycleBonusAmounts({ runId, run, companyRole, onChanged }: Props) {
  const bonus = run.runKind === 'off_cycle' && run.offCycleReason === 'bonus';
  const [inputs, setInputs] = useState<Input[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!bonus) return;
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/off-cycle-amounts`);
      await assertOk(res, 'Could not load the bonus amounts');
      const json = (await res.json()) as { data?: Input[] };
      setInputs(json.data ?? []);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the bonus amounts'));
    }
  }, [bonus, runId]);
  useEffect(() => { void load(); }, [load, run.status]);

  if (!bonus || inputs.length === 0) return <FocusedAlert message={error} />;
  const canEdit = (run.status === 'draft' || run.status === 'calculated') && (companyRole === 'owner' || companyRole === 'admin');

  const save = async (employeeId: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/off-cycle-amounts`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeId, amount: Number(value) }),
      });
      await assertOk(res, 'Could not change the amount - try again');
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not change the amount - try again'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 px-4 py-3 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)]" data-testid="off-cycle-bonus-amounts">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Bonus amounts</h2>
      <FocusedAlert message={error} />
      {canEdit && (
        <p className="text-xs text-[var(--ff-text-secondary)]">
          Changing an amount sends the run back to draft: recalculate it before approval. If the bonus was already paid,
          recovering the difference from the employee happens outside payroll.
        </p>
      )}
      <ul className="divide-y divide-[var(--ff-border-primary)]">
        {inputs.map((i) => (
          <li key={i.employeeId} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
            <span className="text-[var(--ff-text-primary)]">{i.employeeName}</span>
            {editing === i.employeeId ? (
              <span className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`bonus-${i.employeeId}`}>Bonus amount for {i.employeeName}</label>
                <input id={`bonus-${i.employeeId}`} type="number" min="0.01" step="0.01" value={value} onChange={(e) => setValue(e.target.value)}
                  className="w-36 min-h-[44px] px-3 rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)]" />
                <button type="button" onClick={() => void save(i.employeeId)} disabled={busy || !(Number(value) > 0)}
                  className="flex items-center gap-2 px-4 min-h-[44px] rounded-lg bg-brand-700 hover:bg-brand-800 text-white font-medium disabled:opacity-50">
                  {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Save
                </button>
                <button type="button" onClick={() => setEditing(null)} disabled={busy}
                  className="px-4 min-h-[44px] rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)]">Keep</button>
              </span>
            ) : (
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-[var(--ff-text-primary)]">{formatCurrency(i.amount)}</span>
                {canEdit && (
                  <button type="button" onClick={() => { setEditing(i.employeeId); setValue(String(i.amount)); }}
                    aria-label={`Change the bonus amount for ${i.employeeName}`}
                    className="px-3 min-h-[44px] rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)]">Change</button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
