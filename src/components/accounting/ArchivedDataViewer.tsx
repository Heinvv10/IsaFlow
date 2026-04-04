/**
 * Archived journal entries viewer with date filters and pagination.
 */

import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ArchivedEntry } from '@/modules/accounting/services/dataArchivingService';

const ARCHIVE_LIMIT = 50;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    posted: 'bg-green-100 text-green-800 border-green-300',
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
  items: ArchivedEntry[];
  total: number;
  loading: boolean;
  dateFrom: string;
  dateTo: string;
  page: number;
  onDateFromChange: (v: string) => void;
  onDateToChange: (v: string) => void;
  onSearch: () => void;
  onPageChange: (page: number) => void;
}

export function ArchivedDataViewer({ items, total, loading, dateFrom, dateTo, page, onDateFromChange, onDateToChange, onSearch, onPageChange }: Props) {
  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-6">
        {(['from', 'to'] as const).map((key) => (
          <div key={key}>
            <label className="block text-xs text-[var(--ff-text-muted)] mb-1">Date {key === 'from' ? 'From' : 'To'}</label>
            <input type="date"
              value={key === 'from' ? dateFrom : dateTo}
              onChange={(e) => { if (key === 'from') onDateFromChange(e.target.value); else onDateToChange(e.target.value); }}
              className="rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500" />
          </div>
        ))}
        <div className="flex items-end">
          <button onClick={onSearch} disabled={loading}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white disabled:opacity-50 transition-colors">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Search
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[var(--ff-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Loading archived data...</div>
      ) : items.length === 0 ? (
        <div className="flex items-center gap-2 text-[var(--ff-text-muted)]">
          <AlertTriangle className="h-4 w-4" /> No archived journal entries found for the selected date range.
        </div>
      ) : (
        <>
          <p className="text-xs text-[var(--ff-text-muted)] mb-3">
            Showing {page * ARCHIVE_LIMIT + 1}–{Math.min((page + 1) * ARCHIVE_LIMIT, total)} of {total.toLocaleString()} archived entries
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border)]">
                  {['Entry #', 'Date', 'Description', 'Source', 'Status'].map(h => (
                    <th key={h} className="pb-2 text-left font-semibold text-[var(--ff-text-muted)]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border)]">
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="py-2.5 font-mono text-xs text-[var(--ff-text-secondary)]">{item.entryNumber ?? '—'}</td>
                    <td className="py-2.5 text-[var(--ff-text-primary)]">{item.entryDate}</td>
                    <td className="py-2.5 text-[var(--ff-text-secondary)] max-w-xs truncate">{item.description ?? '—'}</td>
                    <td className="py-2.5 text-[var(--ff-text-muted)] capitalize">{item.source ?? '—'}</td>
                    <td className="py-2.5"><StatusBadge status={item.status ?? 'unknown'} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > ARCHIVE_LIMIT && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--ff-border)]">
              <button onClick={() => onPageChange(Math.max(0, page - 1))} disabled={page === 0}
                className="text-sm px-3 py-1.5 rounded-lg border border-[var(--ff-border)] disabled:opacity-40 hover:bg-[var(--ff-bg-secondary)] transition-colors">Previous</button>
              <span className="text-sm text-[var(--ff-text-muted)]">Page {page + 1} of {Math.ceil(total / ARCHIVE_LIMIT)}</span>
              <button onClick={() => onPageChange(page + 1)} disabled={(page + 1) * ARCHIVE_LIMIT >= total}
                className="text-sm px-3 py-1.5 rounded-lg border border-[var(--ff-border)] disabled:opacity-40 hover:bg-[var(--ff-bg-secondary)] transition-colors">Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
