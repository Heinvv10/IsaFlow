/**
 * Customer Invoice Disputes — queue + resolution flow.
 * PRD-06 Phase 3.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { StatusPill } from '@/components/ui';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import { ResolveModal } from '@/components/accounting/disputes/ResolveModal';
import type { DisputeRow, DisputeStatus } from '@/components/accounting/disputes/types';

const PAGE_SIZE = 50;

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  // The list is LIMIT-ed, so neither count may be derived from `disputes`:
  // beyond one page the tiles under-report and the pager cannot size itself.
  const [total, setTotal] = useState(0);
  const [openTotal, setOpenTotal] = useState(0);
  const [openDisputedAmount, setOpenDisputedAmount] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | DisputeStatus>('open');
  const [active, setActive] = useState<DisputeRow | null>(null);

  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      setError('');
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await apiFetch(`/api/accounting/ar/disputes?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load disputes (HTTP ${res.status})`);
      const json = await res.json();
      const data = json?.data;
      setDisputes(data?.disputes ?? []);
      setTotal(Number(data?.total ?? 0));
      setOpenTotal(Number(data?.openTotal ?? 0));
      setOpenDisputedAmount(Number(data?.openDisputedAmount ?? 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load disputes');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  function changeFilter(s: 'all' | DisputeStatus) {
    setStatusFilter(s);
    setOffset(0);
  }

  const firstOnPage = total === 0 ? 0 : offset + 1;
  const lastOnPage = offset + disputes.length;

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 flex items-center gap-2">
              <AlertTriangle className="w-6 h-6 text-amber-500" />
              Customer Disputes
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Disputes raised by customers via the portal or internally. Open disputes are
              excluded from AR overdue buckets.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-slate-500">Open disputes</div>
            <div className="text-2xl font-semibold text-slate-900">{openTotal}</div>
            <div className="text-xs text-slate-500">
              {formatCurrency(openDisputedAmount)} under review
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          {(['open', 'resolved', 'withdrawn', 'rejected', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => changeFilter(s)}
              className={`px-3 py-1.5 rounded-md text-sm border ${
                statusFilter === s
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-10 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading disputes…
          </div>
        )}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
          </div>
        )}

        {!isLoading && !error && (
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">Raised</th>
                  <th className="text-left px-4 py-2">Customer</th>
                  <th className="text-left px-4 py-2">Invoice</th>
                  <th className="text-left px-4 py-2">Reason</th>
                  <th className="text-right px-4 py-2">Amount</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-right px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {disputes.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-10 text-slate-400">
                      No disputes.
                    </td>
                  </tr>
                ) : (
                  disputes.map((d) => (
                    <tr key={d.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-700">{formatDate(d.raisedAt)}</td>
                      <td className="px-4 py-3 text-slate-900">{d.clientName ?? '—'}</td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/accounting/customer-invoices/${d.customerInvoiceId}`}
                          className="text-blue-600 hover:underline"
                        >
                          {d.invoiceNumber ?? d.customerInvoiceId.slice(0, 8)}
                        </Link>
                        {d.customerInvoiceLineId && (
                          <span className="ml-2 text-xs text-slate-400">(line-level)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-700 max-w-md truncate">{d.reason}</td>
                      <td className="px-4 py-3 text-right font-medium">
                        {formatCurrency(d.disputedAmount)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={d.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        {d.status === 'open' ? (
                          <button
                            onClick={() => setActive(d)}
                            className="px-3 py-1 text-xs rounded-md bg-slate-900 text-white hover:bg-slate-800"
                          >
                            Resolve
                          </button>
                        ) : (
                          <span className="text-xs text-slate-400">
                            {d.resolutionMode ?? d.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-sm text-slate-600">
              <span>
                Showing {firstOnPage}–{lastOnPage} of {total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="px-3 py-1.5 rounded-md border border-slate-200 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  disabled={lastOnPage >= total}
                  className="px-3 py-1.5 rounded-md border border-slate-200 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {active && (
        <ResolveModal
          dispute={active}
          onClose={() => setActive(null)}
          onDone={() => {
            setActive(null);
            void load();
          }}
        />
      )}
    </AppLayout>
  );
}
