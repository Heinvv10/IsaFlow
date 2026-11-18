/**
 * The run's pay-frequency changes that pay days twice or leave days unpaid (wave 6 FQd, breaker #1622 M2;
 * GET/POST /api/payroll/runs/[id]/frequency-change). Each names the exact days and says to settle them with a once-off
 * adjustment; an owner or admin then acknowledges it, which lets the run calculate. Nothing renders when there are none.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { apiErrorMessage, apiFetch, apiJson, assertOk } from '@/lib/apiFetch';

interface Straddle {
  employeeId: string; employeeNumber: string; oldFrequency: string; oldEnd: string; start: string;
  overlap: { from: string; to: string } | null; gap: { from: string; to: string } | null; acknowledged: boolean;
}

const days = (d: { from: string; to: string }) => (d.from === d.to ? d.from : `${d.from} to ${d.to}`);

function sentence(s: Straddle): string {
  const what = s.overlap ? `${days(s.overlap)} would be paid twice` : `${days(s.gap!)} would not be paid`;
  return `${s.employeeNumber} was last paid ${s.oldFrequency} up to ${s.oldEnd}, and this run starts on ${s.start}: ${what}.`;
}

export function FrequencyChangeCard({ runId, canAcknowledge }: { runId: string; canAcknowledge: boolean }) {
  const [items, setItems] = useState<Straddle[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const data = (await apiJson(`/api/payroll/runs/${runId}/frequency-change`, undefined, 'Could not load the pay-frequency changes')) as { straddles?: Straddle[] };
      setItems(Array.isArray(data?.straddles) ? data.straddles : []);
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the pay-frequency changes'));
    }
  }, [runId]);
  useEffect(() => { void load(); }, [load]);

  const acknowledge = async (employeeId: string) => {
    setBusy(employeeId);
    setError('');
    try {
      await assertOk(await apiFetch(`/api/payroll/runs/${runId}/frequency-change`, { method: 'POST', body: JSON.stringify({ employeeId }) }),
        'Could not acknowledge the change - try again');
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not acknowledge the change - try again'));
    } finally {
      setBusy('');
    }
  };

  if (items.length === 0 && !error) return null;
  return (
    <section aria-label="Pay-frequency changes" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Pay-frequency changes on this run</h2>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        Settle these days with a once-off adjustment on the employee, then acknowledge them. The run calculates once every change is acknowledged.
      </p>
      <ul className="space-y-2">
        {items.map((s) => (
          <li key={s.employeeId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-[var(--ff-text-primary)]">{sentence(s)}</span>
            {s.acknowledged
              ? <span className="text-sm text-emerald-700 dark:text-emerald-400">Acknowledged</span>
              : canAcknowledge && (
                <Button variant="secondary" size="sm" loading={busy === s.employeeId} aria-label={`Acknowledge for ${s.employeeNumber}`}
                  onClick={() => void acknowledge(s.employeeId)}>Acknowledge</Button>
              )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
    </section>
  );
}
