/**
 * /accounting/budgets/review (budgets P5-6, spec §5): the budget-holder slice board.
 * - Owner / admin: every slice of every version in four columns (open, submitted, returned,
 *   approved) with due dates and holders; approve, or return with a note, a submitted slice; assign a
 *   holder to a slice of a draft version.
 * - Anyone else ("My budget slices"): their own slices; submit an open or returned one for review.
 * `?version=<id>` narrows the board to one version (the links in the bell). The server enforces
 * every rule; this page only offers what the viewer may do.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { ClipboardCheck } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorMessage } from '@/lib/apiFetch';
import { todayInSast } from '@/lib/saDateParser';
import { SLICE_STATUSES, type SliceStatus } from '@/modules/accounting/services/budgets/holderSlices';
import { AssignHolderForm } from './AssignHolderForm';
import { SliceCard } from './SliceCard';
import { fetchSlices, type SliceReview } from './reviewClient';

const PANEL = 'rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]';
const COLUMN: Record<SliceStatus, string> = { open: 'Open', submitted: 'Submitted for review', returned: 'Returned', approved: 'Approved' };

export function BudgetReviewPage() {
  const { companyRole, activeCompany } = useCompany();
  const { user } = useAuth();
  const router = useRouter();
  const versionId = typeof router.query.version === 'string' ? router.query.version : null;
  const reviewer = companyRole === 'owner' || companyRole === 'admin';
  const [slices, setSlices] = useState<SliceReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const today = useMemo(() => todayInSast(), []);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSlices(await fetchSlices(versionId));
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the budget slices.'));
    }
  }, [versionId]);
  useEffect(() => { if (activeCompany && router.isReady) void load(); }, [activeCompany, router.isReady, load]);

  const replace = (s: SliceReview) => setSlices((prev) => {
    const list = prev ?? [];
    return list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [s, ...list];
  });

  return (
    <div className="min-h-screen bg-[var(--ff-bg-primary)]">
      <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ClipboardCheck className="h-6 w-6 shrink-0 text-[var(--ff-brand-eyebrow)]" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{reviewer ? 'Budget Review' : 'My Budget Slices'}</h1>
          </div>
          {reviewer && (
            <button type="button" aria-expanded={assignOpen} onClick={() => setAssignOpen((o) => !o)} data-testid="assign-holder-toggle"
              className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]">
              {assignOpen ? 'Close' : 'Assign a budget holder'}
            </button>
          )}
        </div>
        <p className="mt-2 text-sm text-[var(--ff-text-secondary)]">
          {reviewer
            ? 'Budget holders (managers) prepare their slice of a draft budget and submit it here. Approve it, or return it with a note. A version is approved once every slice is.'
            : 'The parts of the budget you hold. Change them on the Budgets page while they are open or returned, then submit them for review.'}
        </p>
      </div>
      <div className="space-y-4 p-4 sm:p-6">
        {reviewer && assignOpen && <div className={`${PANEL} p-4`}><AssignHolderForm onAssigned={replace} /></div>}
        {versionId && (
          <p className="text-sm text-[var(--ff-text-secondary)]">
            Showing one version. <button type="button" className="underline" onClick={() => { void router.push('/accounting/budgets/review'); }}>Show all</button>
          </p>
        )}
        {error && (
          <div role="alert" className={`${PANEL} flex flex-wrap items-center justify-between gap-2 p-4 text-sm text-error-700 dark:text-error-400`}>
            <span>{error}</span>
            <button type="button" onClick={() => { void load(); }} className="rounded border border-[var(--ff-border-primary)] px-3 py-1 text-[var(--ff-text-primary)]">Retry</button>
          </div>
        )}
        {slices === null && !error && <div className={`${PANEL} h-24 animate-pulse`} aria-busy="true" aria-label="Loading the budget slices" />}
        {slices !== null && slices.length === 0 && (
          <div className={`${PANEL} p-4 text-sm text-[var(--ff-text-secondary)]`} data-testid="review-empty">
            {reviewer ? 'No budget holders are assigned yet. Use “Assign a budget holder” to give a manager a slice of a draft version.' : 'You hold no budget slices.'}
          </div>
        )}
        {slices !== null && slices.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {SLICE_STATUSES.map((status) => {
              const column = slices.filter((s) => s.status === status);
              return (
                <section key={status} className={`${PANEL} p-3`} aria-labelledby={`col-${status}`} data-testid={`review-column-${status}`}>
                  <h2 id={`col-${status}`} className="mb-2 text-sm font-semibold text-[var(--ff-text-primary)]">{COLUMN[status]} ({column.length})</h2>
                  <ul className="space-y-2">
                    {column.map((s) => <SliceCard key={s.id} slice={s} userId={user?.id ?? null} reviewer={reviewer} today={today} onChanged={replace} />)}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
