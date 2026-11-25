/**
 * The run's employees whose line pays a recurring earning its share of the period beside a once-off earning (wave 7 PRA,
 * W29, review #1901 M2; GET/POST /api/payroll/runs/[id]/recurring-share). A once-off entered by hand to pro-rate the same
 * days would pay them twice, so each pair is shown and an owner or admin acknowledges it, which lets the run be approved.
 * Nothing renders when there are none.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';

/** What the card reads of each pair; `message` is the server's sentence (payrollRecurringShare.shareBesideOnceOffResults). */
interface SharePair { employeeId: string; employeeName: string; employeeNumber: string; acknowledged: boolean; message: string }

export function RecurringShareCard({ runId, canAcknowledge }: { runId: string; canAcknowledge: boolean }) {
  const [items, setItems] = useState<SharePair[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const data = (await apiJson(`/api/payroll/runs/${runId}/recurring-share`, undefined, 'Could not load the part-period earnings')) as { pairs?: SharePair[] };
      setItems(Array.isArray(data?.pairs) ? data.pairs : []);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the part-period earnings'));
    }
  }, [runId]);
  useEffect(() => { void load(); }, [load]);

  const acknowledge = async (employeeId: string) => {
    setBusy(employeeId);
    setError('');
    try {
      await assertOk(await apiFetch(`/api/payroll/runs/${runId}/recurring-share`, { method: 'POST', body: JSON.stringify({ employeeId }) }),
        'Could not acknowledge - try again');
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not acknowledge - try again'));
    } finally {
      setBusy('');
    }
  };

  if (items.length === 0 && !error) return null;
  return (
    <section aria-label="Part-period earnings beside once-offs" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Part-period earnings beside once-off earnings</h2>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        Check that no once-off below pro-rates the same days by hand. The run can be approved once every employee is acknowledged.
      </p>
      <ul className="space-y-2">
        {items.map((p) => (
          <li key={p.employeeId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-[var(--ff-text-primary)]">
              <span className="font-medium">{p.employeeNumber} {p.employeeName}</span>: {p.message}
            </span>
            {p.acknowledged
              ? <span className="text-sm text-emerald-700 dark:text-emerald-400">Acknowledged</span>
              : canAcknowledge && (
                <Button variant="secondary" size="sm" loading={busy === p.employeeId} aria-label={`Acknowledge for ${p.employeeName}`}
                  onClick={() => void acknowledge(p.employeeId)}>Acknowledge</Button>
              )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    </section>
  );
}
