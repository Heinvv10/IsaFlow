/**
 * New off-cycle payroll run (wave 6 OC). Route: /payroll/runs/off-cycle
 * A bonus or termination run beside a month's approved regular run: pick the month, the reason, the pay date and the
 * employees (and, for a bonus, its annual-payment earning and each amount). Calculation happens on the run's page.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { Select } from '@/components/ui/Select';
import { DateField } from '@/components/ui/DateField';
import { MoneyField } from '@/components/ui/MoneyField';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { todayInSast } from '@/lib/saDateParser';
import { ArrowLeft, Gift, Loader2 } from 'lucide-react';
import { monthKey, monthLabel, useOffCycleSources, useRunPeople } from '@/components/payroll/offCycle/useOffCycleSources';

type Reason = 'bonus' | 'termination';
const REASONS = [{ value: 'bonus', label: 'Bonus (annual payment)' }, { value: 'termination', label: 'Termination pay-outs' }];
const card = 'rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4';

export default function NewOffCycleRunPage() {
  const router = useRouter();
  const { runs, components, leavers, error: loadError, loading } = useOffCycleSources();
  const [runId, setRunId] = useState<string | null>(null);
  const [reason, setReason] = useState<Reason>('bonus');
  const [runDate, setRunDate] = useState<string | null>(null);
  const [componentId, setComponentId] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, number | null>>({});
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const run = runs.find((r) => r.id === runId) ?? null;
  const { people: onRun, error: runError } = useRunPeople(reason === 'bonus' ? runId : null);
  const today = todayInSast();
  const people = useMemo(
    () => (reason === 'bonus' ? onRun : leavers.filter((l) => run && l.endDate.slice(0, 7) === monthKey(run))),
    [reason, onRun, leavers, run],
  );
  const picked = people.filter((p) => chosen[p.employeeId]);
  const lastDay = run ? new Date(Date.UTC(run.periodYear, run.periodMonth, 0)).toISOString().slice(0, 10) : undefined;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!run || !runDate || picked.length === 0 || (reason === 'bonus' && (!componentId || picked.some((p) => !amounts[p.employeeId])))) {
      setError('Choose the month, the pay date and at least one employee' + (reason === 'bonus' ? ', the bonus earning and each amount.' : '.'));
      return;
    }
    setSubmitting(true);
    setError('');
    let target = '';
    try {
      const res = await apiFetch('/api/payroll/runs/off-cycle', {
        method: 'POST',
        body: JSON.stringify({
          month: run.periodMonth, year: run.periodYear, reason, runDate,
          employees: picked.map((p) => (reason === 'bonus'
            ? { employeeId: p.employeeId, componentId, amount: (amounts[p.employeeId] ?? 0) / 100 }
            : { employeeId: p.employeeId })),
        }),
      });
      await assertOk(res, 'Could not create the off-cycle run - try again');
      const json = await res.json();
      target = `/payroll/runs/${(json.data ?? json).id}`;
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the off-cycle run - try again'));
    } finally {
      if (!target) setSubmitting(false);
    }
    if (!target) return;
    // The run exists; a failed navigation is not a failed save.
    try { await router.push(target); } catch (navErr) { log.warn('navigation failed', { error: navErr }, 'NewOffCycleRunPage'); }
    setSubmitting(false);
  };

  const shownError = error || loadError || runError;
  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-4 sm:px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/runs" aria-label="Back to payroll runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10"><Gift className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New off-cycle run</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">A bonus or termination run beside a month&apos;s approved regular run.</p>
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="p-4 sm:p-6 max-w-2xl space-y-6">
          {shownError && <div role="alert" className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-sm">{shownError}</div>}
          <div className={card}>
            <Select id="oc-month" label="Month (its approved regular run)" required value={runId} loading={loading}
              options={runs.map((r) => ({ value: r.id, label: monthLabel(r) }))} emptyText="No approved regular run yet"
              onChange={(v) => { setRunId(v); setChosen({}); setRunDate(null); }} />
            <Select id="oc-reason" label="Reason" required value={reason} options={REASONS}
              onChange={(v) => { setReason((v ?? 'bonus') as Reason); setChosen({}); }} />
            <DateField id="oc-date" label="Pay date" required value={runDate} onChange={(iso) => setRunDate(iso)}
              minDate={run && lastDay && today <= lastDay ? (today > `${monthKey(run)}-01` ? today : `${monthKey(run)}-01`) : undefined}
              maxDate={lastDay} disabled={!run || !lastDay || today > lastDay} resetKey={runId ?? ''}
              helperText={run && lastDay && today > lastDay ? 'That month has ended: an off-cycle run is paid today or later, inside its month.' : 'In the run\'s month, today or later.'} />
            {reason === 'bonus' && (
              <Select id="oc-component" label="Bonus earning (SARS 3605)" required value={componentId}
                options={components.map((c) => ({ value: c.id, label: c.name }))} emptyText="No annual-payment (3605) earning: add one under Pay components"
                onChange={setComponentId} />
            )}
          </div>

          <fieldset className={card}>
            <legend className="px-1 text-sm font-medium text-[var(--ff-text-primary)]">Employees</legend>
            {!run ? <p className="text-sm text-[var(--ff-text-secondary)]">Choose the month first.</p>
              : people.length === 0 ? <p className="text-sm text-[var(--ff-text-secondary)]">{reason === 'bonus' ? 'No employees on that run.' : 'Nobody has an end date in that month.'}</p>
                : people.map((p) => (
                  <div key={p.employeeId} className="flex flex-col sm:flex-row sm:items-end gap-2">
                    <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] min-h-[44px] sm:flex-1">
                      <input type="checkbox" className="h-4 w-4" checked={chosen[p.employeeId] === true}
                        onChange={(ev) => setChosen((c) => ({ ...c, [p.employeeId]: ev.target.checked }))} />
                      {p.label}
                    </label>
                    {reason === 'bonus' && chosen[p.employeeId] && (
                      <MoneyField id={`oc-amount-${p.employeeId}`} label={`Bonus for ${p.label}`} required className="sm:w-48"
                        value={amounts[p.employeeId] ?? null} min={1}
                        onChange={(cents) => setAmounts((a) => ({ ...a, [p.employeeId]: cents }))} />
                    )}
                  </div>
                ))}
          </fieldset>

          <div className="flex items-center gap-3">
            <button type="submit" disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create off-cycle run
            </button>
            <Link href="/payroll/runs" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">Cancel</Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
