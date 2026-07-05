/**
 * Payroll Batches — list.
 * Route: /payroll/batches
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { Layers, Loader2, AlertCircle, Plus } from 'lucide-react';

interface BatchRow {
  id: string;
  batchType: 'component_values' | 'reimbursive_travel';
  description: string;
  periodYear: number;
  periodMonth: number;
  status: 'draft' | 'validated' | 'posted' | 'cancelled';
  lineCount: number;
  totalAmount: number;
  isRecurring: boolean;
  createdAt: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function StatusBadge({ status }: { status: BatchRow['status'] }) {
  const colors: Record<BatchRow['status'], string> = {
    draft: 'bg-yellow-500/10 text-yellow-400',
    validated: 'bg-blue-500/10 text-blue-400',
    posted: 'bg-emerald-500/10 text-emerald-400',
    cancelled: 'bg-red-500/10 text-red-400',
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status]}`}>{status}</span>;
}

function TypeBadge({ type }: { type: BatchRow['batchType'] }) {
  return (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400">
      {type === 'component_values' ? 'Component' : 'Travel'}
    </span>
  );
}

export default function PayrollBatchesListPage() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | BatchRow['status']>('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : '';
      const res = await apiFetch(`/api/payroll/batches${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setBatches((json.data ?? json) as BatchRow[]);
    } catch {
      setError('Failed to load batches');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Layers className="h-6 w-6 text-indigo-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Batch Transactions</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Bulk component and reimbursive travel entries</p>
              </div>
            </div>
            <Link href="/payroll/batches/new" className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium">
              <Plus className="h-4 w-4" /> New Batch
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-[var(--ff-text-secondary)]">Status</label>
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as BatchRow['status'] | '')}
              className="rounded-md bg-[var(--ff-surface-primary)] border border-[var(--ff-border-primary)] text-sm px-2 py-1 text-[var(--ff-text-primary)]"
            >
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="validated">Validated</option>
              <option value="posted">Posted</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : batches.length === 0 ? (
            <div className="text-center py-16">
              <Layers className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No batches yet</p>
              <Link href="/payroll/batches/new" className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium">
                <Plus className="h-4 w-4" /> Create first batch
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Description</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Period</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Lines</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Total</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map(b => (
                    <tr key={b.id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{b.description}</td>
                      <td className="py-3 px-4"><TypeBadge type={b.batchType} /></td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{MONTHS[b.periodMonth - 1]} {b.periodYear}</td>
                      <td className="py-3 px-4"><StatusBadge status={b.status} /></td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{b.lineCount}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(b.totalAmount)}</td>
                      <td className="py-3 px-4 text-right">
                        <Link href={`/payroll/batches/${b.id}`} className="text-indigo-400 hover:text-indigo-300 text-xs font-medium">Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
