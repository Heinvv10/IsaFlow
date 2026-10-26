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
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
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
      await assertOk(res, 'Could not load disputes - try again');
      const json = await res.json();
      const data = json?.data;
      setDisputes(data?.disputes ?? []);
      setTotal(Number(data?.total ?? 0));
      setOpenTotal(Number(data?.openTotal ?? 0));
      setOpenDisputedAmount(Number(data?.openDisputedAmount ?? 0));
    } catch (err) {
      setDisputes([]); setTotal(0); setOpenTotal(0); setOpenDisputedAmount(0);
      setError(apiErrorMessage(err, 'Could not load disputes - try again'));
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
      <div className="p-6 space-y-6 min-h-full">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-ink flex items-center gap-2">
              <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />
              Customer Disputes
            </h1>
            <p className="text-sm text-ink-muted mt-1">
              Disputes raised by customers via the portal or internally. Open disputes are
              excluded from AR overdue buckets.
            </p>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-ink-muted">Open disputes</div>
            <div className="text-2xl font-semibold text-ink">{openTotal}</div>
            <div className="text-xs text-ink-muted">
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
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-surface-raised text-ink border-line hover:bg-surface-sunken'
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-10 text-ink-muted">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading disputes…
          </div>
        )}
        {error && (
          <div className="p-4 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {!isLoading && !error && (
          <div className="bg-surface-raised border border-line rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-ink-muted text-xs uppercase">
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
                    <td colSpan={7} className="text-center py-10 text-ink-muted">
                      No disputes.
                    </td>
                  </tr>
                ) : (
                  disputes.map((d) => (
                    <tr key={d.id} className="border-t border-line hover:bg-surface-sunken">
                      <td className="px-4 py-3 text-ink-muted">{formatDate(d.raisedAt)}</td>
                      <td className="px-4 py-3 text-ink">{d.clientName ?? '—'}</td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/accounting/customer-invoices/${d.customerInvoiceId}`}
                          className="text-brand-700 dark:text-teal-400 hover:underline"
                        >
                          {d.invoiceNumber ?? d.customerInvoiceId.slice(0, 8)}
                        </Link>
                        {d.customerInvoiceLineId && (
                          <span className="ml-2 text-xs text-ink-muted">(line-level)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-muted max-w-md truncate">{d.reason}</td>
                      <td className="px-4 py-3 text-right font-medium text-ink">
                        {formatCurrency(d.disputedAmount)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill status={d.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        {d.status === 'open' ? (
                          <button
                            onClick={() => setActive(d)}
                            className="px-3 py-1 text-xs rounded-md bg-brand-600 text-white hover:bg-brand-700"
                          >
                            Resolve
                          </button>
                        ) : (
                          <span className="text-xs text-ink-muted">
                            {d.resolutionMode ?? d.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            <div className="flex items-center justify-between px-4 py-3 border-t border-line text-sm text-ink-muted">
              <span>
                Showing {firstOnPage}–{lastOnPage} of {total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                  disabled={offset === 0}
                  className="px-3 py-1.5 rounded-md border border-line text-ink disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  disabled={lastOnPage >= total}
                  className="px-3 py-1.5 rounded-md border border-line text-ink disabled:opacity-40"
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
