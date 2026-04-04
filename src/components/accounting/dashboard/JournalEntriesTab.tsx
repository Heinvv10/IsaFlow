/**
 * Journal Entries Tab — entries table with status filter and display mode toggle
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Plus, Loader2, FileSpreadsheet, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { DisplayModeToggle } from '@/components/accounting/DisplayModeToggle';
import { useDisplayMode } from '@/hooks/useDisplayMode';
import type { JournalEntry } from '@/modules/accounting/types/gl.types';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-amber-500/20 text-amber-400',
    posted: 'bg-teal-500/20 text-teal-400',
    reversed: 'bg-red-500/20 text-red-400',
    voided: 'bg-gray-500/20 text-gray-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase ${colors[status] || colors.draft}`}>
      {status}
    </span>
  );
}

export function JournalEntriesTab() {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const { displayMode, setDisplayMode } = useDisplayMode();

  useEffect(() => {
    loadEntries();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const loadEntries = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/journal-entries?${params}`);
      const data = await res.json();
      const payload = data.data || data;
      setEntries(payload.entries || payload || []);
    } catch (err) {
      log.error('Failed to load journal entries', { error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="ff-select text-sm py-2 px-3 min-w-[160px]"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="posted">Posted</option>
            <option value="reversed">Reversed</option>
          </select>
          <DisplayModeToggle value={displayMode} onChange={setDisplayMode} />
        </div>
        <Link
          href="/accounting/journal-entries/new"
          className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          New Entry
        </Link>
      </div>

      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-8 text-center">
            <FileSpreadsheet className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">No journal entries found</p>
            <Link href="/accounting/journal-entries/new" className="inline-flex items-center gap-2 mt-3 text-sm text-teal-600 hover:text-teal-700 font-medium">
              <Plus className="h-4 w-4" /> Create your first entry
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                  {['Entry #', 'Date', 'Description', 'Source', 'Status', 'Actions'].map((h, i) => (
                    <th key={h} className={`px-6 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] ${i === 5 ? 'text-right' : 'text-left'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map(entry => (
                  <tr key={entry.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                    <td className="px-6 py-3">
                      <Link href={`/accounting/journal-entries/${entry.id}`} className="text-sm font-medium text-teal-600 hover:text-teal-700">
                        {entry.entryNumber}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">
                      {new Date(entry.entryDate).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)] max-w-xs truncate">
                      {entry.description || '-'}
                    </td>
                    <td className="px-6 py-3">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-500/20 text-[var(--ff-text-secondary)]">
                        {entry.source}
                      </span>
                    </td>
                    <td className="px-6 py-3"><StatusBadge status={entry.status} /></td>
                    <td className="px-6 py-3 text-right">
                      <Link href={`/accounting/journal-entries/${entry.id}`} className="text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                        <ChevronRight className="h-4 w-4 inline" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
