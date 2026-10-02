/**
 * Job detail: Engagement Budget / Used / Engagement Budget Balance and hours
 * used vs budgeted. `refreshKey` (the job's updatedAt) re-reads after a save.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { fetchJobBudget, type JobBudgetRow } from './practiceApi';
import { EngagementBudgetSummary, BUDGET_STATE_TEXT } from './EngagementBudgetSummary';

export function JobBudgetPanel({ jobId, refreshKey }: { jobId: string; refreshKey: string }) {
  // undefined = loading; null = no such job for this company.
  const [status, setStatus] = useState<JobBudgetRow | null | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    void (async () => {
      try {
        const row = await fetchJobBudget(jobId);
        if (!cancelled) setStatus(row);
      } catch (err) {
        if (!cancelled) setError(apiErrorMessage(err, 'Could not load the engagement budget - try again'));
      }
    })();
    return () => { cancelled = true; };
  }, [jobId, refreshKey]);

  if (error) return <p className={`text-sm ${BUDGET_STATE_TEXT.over}`}>{error}</p>;
  if (status === null) return null;
  if (status === undefined) return <div className="flex items-center gap-2 text-sm text-[var(--ff-text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin" />Loading engagement budget…</div>;
  return <EngagementBudgetSummary status={status} />;
}
