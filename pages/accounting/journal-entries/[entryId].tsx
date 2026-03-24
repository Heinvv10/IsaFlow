/**
 * Journal Entry Detail Page
 * GET /accounting/journal-entries/:entryId
 * Shows full entry with lines, and actions (post/reverse)
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { log } from '@/lib/logger';
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RotateCcw,
  FileSpreadsheet,
  Calendar,
  User,
  Hash,
} from 'lucide-react';
import type { JournalEntry, JournalLine } from '@/modules/accounting/types/gl.types';

export default function JournalEntryDetailPage() {
  const router = useRouter();
  const { entryId } = router.query;
  const [entry, setEntry] = useState<JournalEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (entryId) loadEntry();
  }, [entryId]);

  const loadEntry = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/accounting/journal-entries-detail?id=${entryId}`);
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'Failed to load entry');
      }
      const data = await res.json();
      setEntry(data.data || data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load journal entry';
      setError(msg);
      log.error('Failed to load journal entry', { entryId, error: err }, 'accounting-ui');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = useCallback(async (action: 'post' | 'reverse') => {
    if (!entry) return;
    setActionLoading(action);
    try {
      const res = await fetch('/api/accounting/journal-entries-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: entry.id, action }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || `Failed to ${action} entry`);
      }
      await loadEntry();
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to ${action} entry`;
      setError(msg);
      log.error('Journal entry action failed', { entryId, action, error: err }, 'accounting-ui');
    } finally {
      setActionLoading(null);
    }
  }, [entry, entryId]);

  const formatCurrency = (amount: number | string) => {
    const num = Number(amount);
    return num === 0 ? '-' : `R ${num.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const statusColors: Record<string, string> = {
    draft: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    posted: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    reversed: 'bg-red-500/20 text-red-400 border-red-500/30',
    voided: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                href="/accounting?tab=journal-entries"
                className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)] transition-colors"
              >
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  {entry?.entryNumber || 'Journal Entry'}
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {entry ? new Date(entry.entryDate).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}
                </p>
              </div>
            </div>

            {entry && (
              <div className="flex items-center gap-3">
                <span className={`inline-flex items-center px-3 py-1 rounded-lg text-sm font-medium uppercase border ${statusColors[entry.status] || statusColors.draft}`}>
                  {entry.status}
                </span>

                {entry.status === 'draft' && (
                  <button
                    onClick={() => handleAction('post')}
                    disabled={actionLoading === 'post'}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors text-sm font-medium disabled:opacity-50"
                  >
                    {actionLoading === 'post' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" />
                    )}
                    Post Entry
                  </button>
                )}

                {entry.status === 'posted' && !entry.reversedBy && (
                  <button
                    onClick={() => handleAction('reverse')}
                    disabled={actionLoading === 'reverse'}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium disabled:opacity-50"
                  >
                    {actionLoading === 'reverse' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="h-4 w-4" />
                    )}
                    Reverse
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-6">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            </div>
          ) : error ? (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-sm font-medium text-red-400">Error</h3>
                <p className="text-sm text-red-400/80 mt-1">{error}</p>
              </div>
            </div>
          ) : entry ? (
            <div className="space-y-6">
              {/* Entry Details */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] mb-4">Entry Details</h3>
                  <div className="space-y-3">
                    <DetailRow icon={Hash} label="Entry Number" value={entry.entryNumber} />
                    <DetailRow icon={Calendar} label="Entry Date" value={new Date(entry.entryDate).toLocaleDateString()} />
                    <DetailRow icon={FileSpreadsheet} label="Source" value={entry.source} />
                    <DetailRow icon={User} label="Created By" value={entry.createdBy} />
                    {entry.description && (
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)] mb-1">Description</p>
                        <p className="text-sm text-[var(--ff-text-primary)]">{entry.description}</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)] mb-4">Summary</h3>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-[var(--ff-text-secondary)]">Total Debit</span>
                      <span className="text-lg font-bold text-[var(--ff-text-primary)]">
                        {formatCurrency(entry.lines?.reduce((s, l) => s + Number(l.debit), 0) || 0)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-[var(--ff-text-secondary)]">Total Credit</span>
                      <span className="text-lg font-bold text-[var(--ff-text-primary)]">
                        {formatCurrency(entry.lines?.reduce((s, l) => s + Number(l.credit), 0) || 0)}
                      </span>
                    </div>
                    <div className="border-t border-[var(--ff-border-light)] pt-3">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-[var(--ff-text-secondary)]">Line Count</span>
                        <span className="text-sm font-medium text-[var(--ff-text-primary)]">{entry.lines?.length || 0}</span>
                      </div>
                    </div>
                    {entry.reversalOfId && (
                      <div className="bg-red-500/10 border border-red-500/20 rounded p-2 mt-2">
                        <p className="text-xs text-red-400">This entry is a reversal</p>
                      </div>
                    )}
                    {entry.reversedBy && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded p-2 mt-2">
                        <p className="text-xs text-amber-400">This entry has been reversed</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Journal Lines */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
                  <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Journal Lines</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-[var(--ff-bg-tertiary)] border-b border-[var(--ff-border-light)]">
                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">#</th>
                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Account</th>
                        <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Description</th>
                        <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Debit</th>
                        <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-secondary)]">Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.lines?.map((line, idx) => (
                        <tr key={line.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                          <td className="px-6 py-3 text-sm text-[var(--ff-text-tertiary)]">{idx + 1}</td>
                          <td className="px-6 py-3">
                            <div className="text-sm font-medium text-[var(--ff-text-primary)]">{line.accountCode || '-'}</div>
                            <div className="text-xs text-[var(--ff-text-secondary)]">{line.accountName || ''}</div>
                          </td>
                          <td className="px-6 py-3 text-sm text-[var(--ff-text-primary)]">{line.description || '-'}</td>
                          <td className="px-6 py-3 text-sm text-right font-medium text-[var(--ff-text-primary)]">
                            {formatCurrency(line.debit)}
                          </td>
                          <td className="px-6 py-3 text-sm text-right font-medium text-[var(--ff-text-primary)]">
                            {formatCurrency(line.credit)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-[var(--ff-bg-tertiary)] border-t-2 border-[var(--ff-border-medium)]">
                        <td colSpan={3} className="px-6 py-3 text-sm font-semibold text-[var(--ff-text-primary)]">Total</td>
                        <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">
                          {formatCurrency(entry.lines?.reduce((s, l) => s + Number(l.debit), 0) || 0)}
                        </td>
                        <td className="px-6 py-3 text-sm text-right font-bold text-[var(--ff-text-primary)]">
                          {formatCurrency(entry.lines?.reduce((s, l) => s + Number(l.credit), 0) || 0)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}

function DetailRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <Icon className="h-4 w-4 text-[var(--ff-text-tertiary)] flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">{label}</p>
        <p className="text-sm text-[var(--ff-text-primary)]">{value}</p>
      </div>
    </div>
  );
}
