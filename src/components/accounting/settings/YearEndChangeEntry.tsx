/**
 * Settings -> General: the current financial year end and the way to change it.
 * Owner/admin only: the route answers 403 to anyone else (or fails), and the
 * section then stays hidden.
 */
import { useEffect, useState } from 'react';
import { fmtDay, fmtInstantDay } from '@/components/accounting/financialYearEnd/yearEndTypes';
import Link from 'next/link';
import { apiJson } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

type Overview = Awaited<ReturnType<typeof load>>;

function load() {
  return apiJson('/api/accounting/financial-year-end-change', undefined, 'Could not load the financial year end');
}

export function YearEndChangeEntry() {
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    let live = true;
    load().then(d => { if (live) setData(d); }).catch((err: unknown) => {
      // 403 for a non-admin, or any failure: the section is a convenience, so it hides.
      log.warn('Year-end change entry hidden', { error: err }, 'settings-general');
    });
    return () => { live = false; };
  }, []);

  if (!data) return null;
  const latest = data.history[0];
  return (
    <div className="md:col-span-2 rounded-lg border border-[var(--ff-border-primary)] p-4" data-testid="year-end-change-entry">
      <p className="text-sm text-[var(--ff-text-primary)]" data-testid="current-year-end">
        Current financial year: FY{data.currentYear.fiscalYear}, {fmtDay(data.currentYear.startDate)} to {fmtDay(data.currentYear.endDate)}
        {data.currentYear.kind === 'transition' ? ' (transition year)' : ''}
      </p>
      {latest && (
        <p className="text-xs text-[var(--ff-text-tertiary)] mt-1" data-testid="latest-year-end-change">
          Latest change: {fmtInstantDay(latest.appliedAt)}, year end moved to {fmtDay(latest.toEndDate)}{latest.reversedAt ? ' (undone)' : ''}.
        </p>
      )}
      <Link href="/accounting/financial-year-end-change" data-testid="change-year-end-link"
        className="inline-block mt-3 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium">
        Change financial year end
      </Link>
    </div>
  );
}
