/**
 * Batch Payment Detail Page
 * View batch summary, constituent payments, approve/process/cancel
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Layers, Loader2, AlertCircle, Check, Zap, XCircle } from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  approved: 'bg-blue-500/20 text-blue-400',
  processed: 'bg-teal-500/20 text-teal-400',
  cancelled: 'bg-red-500/20 text-red-400',
};

interface BatchPayment {
  id: string;
  paymentNumber: string;
  supplierName: string;
  amount: number;
  status: string;
}

interface BatchDetail {
  id: string;
  batchNumber: string;
  batchDate: string;
  totalAmount: number;
  paymentCount: number;
  paymentMethod: string;
  bankAccountId?: string;
  status: string;
  payments: BatchPayment[];
}

export default function BatchPaymentDetailPage() {
  const router = useRouter();
  const batchId = router.query.batchId as string;

  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState('');

  const load = useCallback(async () => {
    if (!batchId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/batch-payments?id=${batchId}`);
      const json = await res.json();
      setBatch(json.data || null);
    } catch {
      setError('Failed to load batch');
    } finally {
      setIsLoading(false);
    }
  }, [batchId]);

  useEffect(() => { load(); }, [load]);

  async function doAction(action: string) {
    if (!batch) return;
    setActionBusy(action);
    try {
      const res = await apiFetch('/api/accounting/batch-payments-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id: batch.id }),
      });
      if (!res.ok) {
        const json = await res.json();
        setError(json.error || `Failed to ${action}`);
      } else {
        load();
      }
    } catch {
      setError(`Failed to ${action} batch`);
    } finally {
      setActionBusy('');
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/accounting/batch-payments" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <Layers className="h-6 w-6 text-indigo-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  {batch?.batchNumber || 'Batch Detail'}
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {batch ? `${batch.paymentCount} payments • ${batch.paymentMethod?.toUpperCase()}` : 'Loading...'}
                </p>
              </div>
              {batch && (
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_BADGE[batch.status] || ''}`}>
                  {batch.status}
                </span>
              )}
            </div>
            {batch && (
              <div className="flex items-center gap-2">
                {batch.status === 'draft' && (
                  <>
                    <button onClick={() => doAction('approve')} disabled={!!actionBusy}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
                      {actionBusy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Approve
                    </button>
                    <button onClick={() => doAction('cancel')} disabled={!!actionBusy}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-red-600/10 text-red-400 rounded-lg hover:bg-red-600/20 text-sm font-medium disabled:opacity-50">
                      <XCircle className="h-4 w-4" /> Cancel
                    </button>
                  </>
                )}
                {batch.status === 'approved' && (
                  <button onClick={() => doAction('process')} disabled={!!actionBusy}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
                    {actionBusy === 'process' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} Process
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : batch ? (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Batch Total</p>
                  <p className="text-xl font-bold text-indigo-400">{fmt(batch.totalAmount)}</p>
                </div>
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Batch Date</p>
                  <p className="text-lg font-medium text-[var(--ff-text-primary)]">{formatDate(batch.batchDate)}</p>
                </div>
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Payment Count</p>
                  <p className="text-lg font-medium text-[var(--ff-text-primary)]">{batch.paymentCount}</p>
                </div>
                <div className="p-4 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <p className="text-xs text-[var(--ff-text-tertiary)]">Method</p>
                  <p className="text-lg font-medium text-[var(--ff-text-primary)] uppercase">{batch.paymentMethod}</p>
                </div>
              </div>

              {/* Constituent Payments */}
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
                <div className="px-4 py-3 border-b border-[var(--ff-border-light)]">
                  <h3 className="text-sm font-medium text-[var(--ff-text-primary)]">Payments in this Batch</h3>
                </div>
                {batch.payments && batch.payments.length > 0 ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ff-border-light)]">
                        <th className="px-4 py-3 text-left text-[var(--ff-text-secondary)] font-medium">Payment #</th>
                        <th className="px-4 py-3 text-left text-[var(--ff-text-secondary)] font-medium">Supplier</th>
                        <th className="px-4 py-3 text-right text-[var(--ff-text-secondary)] font-medium">Amount</th>
                        <th className="px-4 py-3 text-left text-[var(--ff-text-secondary)] font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.payments.map((p) => (
                        <tr key={p.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)]">
                          <td className="px-4 py-3 text-[var(--ff-text-primary)] font-mono">
                            <Link href={`/accounting/supplier-payments/${p.id}`} className="hover:text-indigo-400">
                              {p.paymentNumber}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{p.supplierName}</td>
                          <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{fmt(Number(p.amount))}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[p.status] || ''}`}>{p.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-8 text-center text-[var(--ff-text-tertiary)]">No individual payments in this batch</div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}
