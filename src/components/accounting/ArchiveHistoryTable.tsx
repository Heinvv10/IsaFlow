/**
 * Archive History table — shows past archive run records.
 */

import { Loader2 } from 'lucide-react';
import type { ArchiveRun } from '@/modules/accounting/services/dataArchivingService';

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    completed: 'bg-green-100 text-green-800 border-green-300',
    running: 'bg-blue-100 text-blue-800 border-blue-300',
    pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    failed: 'bg-red-100 text-red-800 border-red-300',
  };
  const cls = map[status] ?? 'bg-gray-100 text-gray-800 border-gray-300';
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

interface Props {
  runs: ArchiveRun[];
  loading: boolean;
}

export function ArchiveHistoryTable({ runs, loading }: Props) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[var(--ff-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading history...
      </div>
    );
  }
  if (runs.length === 0) {
    return <p className="text-sm text-[var(--ff-text-muted)]">No archive runs yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border)]">
            {['Date Run', 'Cutoff', 'Status', 'Entries', 'Transactions', 'Invoices', 'Duration'].map((h, i) => (
              <th key={h} className={`pb-2 ${i < 3 ? 'text-left' : 'text-right'} font-semibold text-[var(--ff-text-muted)]`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ff-border)]">
          {runs.map((run) => {
            const duration = run.startedAt && run.completedAt
              ? Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
              : null;
            return (
              <tr key={run.id}>
                <td className="py-2.5 text-[var(--ff-text-secondary)]">{new Date(run.createdAt).toLocaleDateString('en-ZA')}</td>
                <td className="py-2.5 text-[var(--ff-text-primary)] font-medium">{run.cutoffDate}</td>
                <td className="py-2.5"><StatusBadge status={run.status} /></td>
                <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">{run.entriesArchived.toLocaleString()}</td>
                <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">{run.transactionsArchived.toLocaleString()}</td>
                <td className="py-2.5 text-right text-[var(--ff-text-secondary)]">{(run.invoicesArchived + run.supplierInvoicesArchived).toLocaleString()}</td>
                <td className="py-2.5 text-right text-[var(--ff-text-muted)]">{duration !== null ? `${duration}s` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
