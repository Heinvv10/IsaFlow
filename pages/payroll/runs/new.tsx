/**
 * New Payroll Run — Phase 2; weekly and fortnightly periods from wave 6 FQd (RunPeriodPicker).
 * Route: /payroll/runs/new
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { Plus, ArrowLeft, Loader2 } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { MonthField } from '@/components/ui/MonthField';
import { todayInSast } from '@/lib/saDateParser';
import { RunPeriodPicker } from '@/components/payroll/RunPeriodPicker';

const FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' }, { value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' },
];
type Frequency = 'monthly' | 'weekly' | 'fortnightly';

export default function NewPayrollRunPage() {
  const router = useRouter();
  const [frequency, setFrequency] = useState<Frequency>('monthly');
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [payMonth, setPayMonth] = useState<string | null>(() => todayInSast().slice(0, 7));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  /** The run that already holds the chosen period (409 PAY_PERIOD_EXISTS): linked beside the error (review #1622 UI L3). */
  const [existing, setExisting] = useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (frequency === 'monthly' && !payMonth) {
      setError('Choose the month the run pays for.');
      return;
    }
    if (frequency !== 'monthly' && !periodStart) {
      setError('Choose the period the run pays for.');
      return;
    }
    setSubmitting(true);
    setError('');
    setExisting(null);
    let target = '';
    try {
      const res = await apiFetch('/api/payroll/runs', {
        method: 'POST',
        body: JSON.stringify(frequency === 'monthly' ? { month: Number((payMonth ?? '').slice(5)), year: Number((payMonth ?? '').slice(0, 4)) } : { frequency, periodStart }),
      });
      if (res.status === 409) {
        const body = await res.clone().json().catch(() => null) as { error?: { details?: { runId?: unknown } } } | null;
        const runId = body?.error?.details?.runId;
        if (typeof runId === 'string') setExisting(runId);
      }
      await assertOk(res, 'Could not create the payroll run - try again');
      const json = await res.json();
      const created = json.data ?? json;
      target = `/payroll/runs/${created.id}`;
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the payroll run - try again'));
    } finally {
      if (!target) setSubmitting(false);
    }
    if (!target) return;
    // The run exists; a failed navigation is not a failed save.
    try { await router.push(target); } catch (e) { log.warn('navigation failed', { error: e }, 'NewPayrollRunPage'); }
    setSubmitting(false);
  };


  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/runs" aria-label="Back to payroll runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Plus className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Payroll Run</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Pick the period — calculation happens on the next page.</p>
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="p-6 max-w-md space-y-6">
          {error && (
            <div role="alert" className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-400 text-sm">
              {error}
              {existing && <> <Link href={`/payroll/runs/${existing}`} className="underline">Open the existing run</Link></>}
            </div>
          )}
          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <Select label="Pay frequency" options={FREQUENCIES} value={frequency}
              onChange={v => { if (v) { setFrequency(v as Frequency); setError(''); } }} />
            {frequency === 'monthly' ? (
              <MonthField label="Month" required minMonth="2000-01" maxMonth="2100-12" value={payMonth} onChange={ym => setPayMonth(ym)} />
            ) : (
              <RunPeriodPicker frequency={frequency} value={periodStart} onChange={setPeriodStart} />
            )}
            <p className="text-sm text-[var(--ff-text-secondary)]">The run pays only employees paid {frequency}.</p>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Run
            </button>
            <Link href="/payroll/runs" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
