/**
 * Payroll runs as cards, for screens below `md`. The table in pages/payroll/runs/index.tsx takes over at `md`:
 * both trees are always rendered and toggled with `hidden md:block` / `md:hidden`, so there is no
 * client-only breakpoint check and nothing to mismatch on hydration.
 */
import Link from 'next/link';
import { formatCurrency } from '@/utils/formatters';

export interface RunRow {
  id: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalNet: number;
  employeeCount: number;
  journalEntryId: string | null;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const periodLabel = (r: RunRow) => `${MONTHS[r.periodMonth - 1]} ${r.periodYear}`;

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-500/10 text-yellow-400',
    calculated: 'bg-blue-500/10 text-blue-400',
    approved: 'bg-teal-500/10 text-teal-400',
    posted: 'bg-emerald-500/10 text-emerald-400',
    cancelled: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-500/10 text-gray-400'}`}>
      {status}
    </span>
  );
}

export function RunCards({ runs, mayWrite }: { runs: RunRow[]; mayWrite: boolean }) {
  return (
    <ul className="md:hidden space-y-3" aria-label="Payroll runs">
      {runs.map(r => (
        <li key={r.id} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[var(--ff-text-primary)]">{periodLabel(r)}</span>
            <StatusBadge status={r.status} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-[var(--ff-text-secondary)]">Employees</dt>
            <dd className="text-right text-[var(--ff-text-primary)]">{r.employeeCount}</dd>
            <dt className="text-[var(--ff-text-secondary)]">Net</dt>
            <dd className="text-right tabular-nums font-medium text-[var(--ff-text-primary)]">{formatCurrency(r.totalNet)}</dd>
          </dl>
          {(mayWrite || r.journalEntryId) && (
            <div className="mt-3 flex items-center gap-4 text-sm font-medium">
              {mayWrite && (
                <Link href={`/payroll/runs/${r.id}`} className="inline-flex min-h-[44px] items-center text-teal-400 hover:text-teal-300">
                  View run<span className="sr-only"> {periodLabel(r)}</span>
                </Link>
              )}
              {r.journalEntryId && (
                <Link href={`/accounting/journal-entries/${r.journalEntryId}`} className="inline-flex min-h-[44px] items-center text-teal-400 hover:text-teal-300">
                  View journal<span className="sr-only"> {periodLabel(r)}</span>
                </Link>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
