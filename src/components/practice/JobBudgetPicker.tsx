/**
 * Optional Job select for the time entry form, listing the chosen client's open
 * jobs, with the chosen job's Engagement Budget and balance shown read-only.
 * The budget warns and never blocks saving. `refreshKey` re-reads the figures
 * (bump it after an entry is saved so the balance includes it).
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { fetchJobBudgets, type JobBudgetRow } from './practiceApi';
import { EngagementBudgetSummary, BUDGET_STATE_TEXT } from './EngagementBudgetSummary';
import { CLOSED_JOB_STATUSES } from '@/modules/accounting/services/practice/practiceJobBudget';


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
  // True once this client's list has loaded: an empty list mid-reload must not clear the chosen job.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setJobs([]); setError(''); setLoaded(false);
    if (!practiceClientId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchJobBudgets(practiceClientId);
        if (cancelled) return;
        setJobs(rows.filter((j) => !CLOSED_JOB_STATUSES.includes(j.jobStatus)).sort((a, b) => a.title.localeCompare(b.title)));
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err, 'Could not load the jobs - try again'));
      }
    })();
    return () => { cancelled = true; };
  }, [practiceClientId, refreshKey]);

  // A chosen job that has since closed is no longer offered: drop it rather than send a hidden id.
  useEffect(() => {
    if (loaded && jobId && !jobs.some((j) => j.jobId === jobId)) onChange('');
  }, [loaded, jobs, jobId, onChange]);

  const selected = jobs.find((j) => j.jobId === jobId);
  const placeholder = !practiceClientId ? 'Pick a client first' : jobs.length ? 'No job' : 'No open jobs for this client';

  return (
    <div className="space-y-2">
      <label className={labelClassName}>Job</label>
      <select value={jobId} onChange={(e) => onChange(e.target.value)} disabled={!practiceClientId} className={selectClassName}>
        <option value="">{placeholder}</option>
        {jobs.map((j) => <option key={j.jobId} value={j.jobId}>{j.title}</option>)}
      </select>
      {error && <p className={`text-xs ${BUDGET_STATE_TEXT.over}`}>{error}</p>}
      {selected && <EngagementBudgetSummary status={selected} />}
    </div>
  );
}
