/**
 * Optional Job select for the time entry form, listing the chosen client's open
 * jobs, with the chosen job's Engagement Budget and balance shown read-only.
 * The budget warns and never blocks saving. `refreshKey` re-reads the figures
 * (bump it after an entry is saved so the balance includes it).
 */
import { useEffect, useState } from 'react';
import { fetchJobBudgets, type JobBudgetRow } from './practiceApi';
import { EngagementBudgetSummary } from './EngagementBudgetSummary';

/** A job time can still be captured against. */
const CLOSED = new Set<JobBudgetRow['jobStatus']>(['complete', 'cancelled', 'billed']);

interface Props {
  practiceClientId: string;
  jobId: string;
  onChange: (jobId: string) => void;
  refreshKey: number;
  selectClassName: string;
  labelClassName: string;
}

export function JobBudgetPicker({ practiceClientId, jobId, onChange, refreshKey, selectClassName, labelClassName }: Props) {
  const [jobs, setJobs] = useState<JobBudgetRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    setJobs([]); setError('');
    if (!practiceClientId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchJobBudgets(practiceClientId);
        if (!cancelled) setJobs(rows.filter((j) => !CLOSED.has(j.jobStatus)).sort((a, b) => a.title.localeCompare(b.title)));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load jobs');
      }
    })();
    return () => { cancelled = true; };
  }, [practiceClientId, refreshKey]);

  const selected = jobs.find((j) => j.jobId === jobId);
  const placeholder = !practiceClientId ? 'Pick a client first' : jobs.length ? 'No job' : 'No open jobs for this client';

  return (
    <div className="space-y-2">
      <label className={labelClassName}>Job</label>
      <select value={jobId} onChange={(e) => onChange(e.target.value)} disabled={!practiceClientId} className={selectClassName}>
        <option value="">{placeholder}</option>
        {jobs.map((j) => <option key={j.jobId} value={j.jobId}>{j.title}</option>)}
      </select>
      {error && <p className="text-xs text-red-400">Could not load jobs: {error}</p>}
      {selected && <EngagementBudgetSummary status={selected} />}
    </div>
  );
}
