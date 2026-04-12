/**
 * Netcash Submissions — list all EFT/debit order submissions for this company.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Banknote, RefreshCw, Loader2, AlertCircle, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';

interface Submission {
  id: string;
  submission_type: 'eft_payment' | 'debit_order';
  batch_reference: string | null;
  total_amount_cents: number;
  record_count: number;
  status: 'pending' | 'submitted' | 'processing' | 'completed' | 'failed';
  submitted_at: string | null;
  created_at: string;
  created_by: string | null;
}

const STATUS_BADGE: Record<Submission['status'], string> = {
  pending:    'bg-gray-500/20 text-gray-400',
  submitted:  'bg-blue-500/20 text-blue-400',
  processing: 'bg-amber-500/20 text-amber-400',
  completed:  'bg-teal-500/20 text-teal-400',
  failed:     'bg-red-500/20 text-red-400',
};

function formatRands(cents: number): string {
  return `R ${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function formatDate(val: string | null): string {
  if (!val) return '—';
  try { return new Date(val).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return val; }
}

export default function NetcashSubmissionsPage() {
  const { activeCompany } = useCompany();
  const [items, setItems] = useState<Submission[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pollingId, setPollingId] = useState<string | null>(null);

  const fetchSubmissions = useCallback(async () => {
    if (!activeCompany?.id) return;
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/netcash/submissions?limit=50');
      const json = await res.json() as { data?: { items: Submission[]; total: number } };
      if (json.data) { setItems(json.data.items); setTotal(json.data.total); }
    } catch {
      setError('Failed to load submissions');
    } finally {
      setLoading(false);
    }
  }, [activeCompany?.id]);

  useEffect(() => { void fetchSubmissions(); }, [fetchSubmissions]);

  const handlePollStatus = async (submissionId: string) => {
    setPollingId(submissionId);
    try {
      await apiFetch(`/api/accounting/netcash/status?submissionId=${submissionId}`);
      await fetchSubmissions();
    } finally {
      setPollingId(null);
    }
  };

  return (
    <AppLayout>
      <div className="p-4 lg:p-6 space-y-6 max-w-6xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><Banknote className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Netcash Submissions</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">EFT batch payments and debit order submissions — {total} total</p>
            </div>
          </div>
          <button
            onClick={() => void fetchSubmissions()}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--ff-border-primary)] text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-center gap-2 text-red-500 text-sm">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 text-[var(--ff-text-secondary)]">
            <Banknote className="h-12 w-12 mx-auto mb-3 opacity-20" />
            <p className="text-lg font-medium">No submissions yet</p>
            <p className="text-sm mt-1">Submit an EFT batch from Supplier Payments to see it here.</p>
          </div>
        ) : (
          <div className="bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider">Date</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider">Batch Ref</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider">Amount</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider">Records</th>
                  <th className="text-center px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider">Status</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--ff-text-secondary)] uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-primary)]">
                {items.map(s => (
                  <tr key={s.id} className="hover:bg-[var(--ff-bg-secondary)]/50 transition-colors">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)]">{formatDate(s.submitted_at ?? s.created_at)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">
                      {s.submission_type === 'eft_payment' ? 'EFT Payment' : 'Debit Order'}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-secondary)]">
                      {s.batch_reference ?? <span className="text-[var(--ff-text-tertiary)]">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-[var(--ff-text-primary)]">
                      {formatRands(s.total_amount_cents)}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{s.record_count}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_BADGE[s.status]}`}>
                        {s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {(s.status === 'submitted' || s.status === 'processing') && (
                          <button
                            onClick={() => void handlePollStatus(s.id)}
                            disabled={pollingId === s.id}
                            className="flex items-center gap-1 text-xs text-teal-500 hover:text-teal-400 disabled:opacity-50"
                          >
                            <RefreshCw className={`h-3.5 w-3.5 ${pollingId === s.id ? 'animate-spin' : ''}`} />
                            Check status
                          </button>
                        )}
                        {s.batch_reference && (
                          <a
                            href={`https://merchant.netcash.co.za/batch/${s.batch_reference}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
