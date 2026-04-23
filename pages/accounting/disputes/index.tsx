/**
 * Customer Invoice Disputes — queue + resolution flow.
 * PRD-06 Phase 3.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { AlertTriangle, Loader2, CheckCircle, XCircle, Undo2 } from 'lucide-react';
import { StatusPill } from '@/components/ui';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

type DisputeStatus = 'open' | 'resolved' | 'withdrawn' | 'rejected';

interface DisputeRow {
  id: string;
  customerInvoiceId: string;
  customerInvoiceLineId: string | null;
  reason: string;
  raisedBy: string;
  raisedAt: string;
  status: DisputeStatus;
  disputedAmount: number;
  resolvedAt: string | null;
  resolutionMode: string | null;
  creditNoteId: string | null;
  invoiceNumber?: string | null;
  clientName?: string | null;
}

type ResolveMode = 'resolve_with_credit' | 'resolve_no_credit' | 'rejected';

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | DisputeStatus>('open');
  const [active, setActive] = useState<DisputeRow | null>(null);

  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      setError('');
      const qs = statusFilter === 'all' ? '' : `?status=${statusFilter}`;
      const res = await apiFetch(`/api/accounting/ar/disputes${qs}`);
      const json = await res.json();
      const list: DisputeRow[] = json?.data?.disputes ?? [];
      setDisputes(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load disputes');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCount = disputes.filter((d) => d.status === 'open').length;
  const totalDisputed = disputes
    .filter((d) => d.status === 'open')
    .reduce((sum, d) => sum + Number(d.disputedAmount || 0), 0);

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
            <div className="text-2xl font-semibold text-slate-900">{openCount}</div>
            <div className="text-xs text-slate-500">
              {formatCurrency(totalDisputed)} under review
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          {(['open', 'resolved', 'withdrawn', 'rejected', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
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

function ResolveModal({
  dispute,
  onClose,
  onDone,
}: {
  dispute: DisputeRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<ResolveMode>('resolve_with_credit');
  const [note, setNote] = useState('');
  const [creditDate, setCreditDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  async function submit(action: 'resolve' | 'withdraw') {
    try {
      setSubmitting(true);
      setErr('');
      const res =
        action === 'withdraw'
          ? await apiFetch(`/api/accounting/ar/disputes/${dispute.id}/withdraw`, {
              method: 'POST',
              body: JSON.stringify({ note: note || undefined }),
            })
          : await apiFetch(`/api/accounting/ar/disputes/${dispute.id}/resolve`, {
              method: 'POST',
              body: JSON.stringify({
                mode,
                note: note || undefined,
                ...(mode === 'resolve_with_credit' ? { creditDate } : {}),
              }),
            });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to resolve dispute');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="p-5 border-b border-slate-100">
          <h2 className="text-lg font-semibold text-slate-900">Resolve dispute</h2>
          <p className="text-sm text-slate-500 mt-1">
            {dispute.invoiceNumber} · {formatCurrency(dispute.disputedAmount)} disputed
          </p>
        </div>

        <div className="p-5 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Resolution</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as ResolveMode)}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm"
            >
              <option value="resolve_with_credit">Resolve with credit note</option>
              <option value="resolve_no_credit">Resolve — no credit</option>
              <option value="rejected">Reject dispute</option>
            </select>
          </label>

          {mode === 'resolve_with_credit' && (
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Credit note date</span>
              <input
                type="date"
                value={creditDate}
                onChange={(e) => setCreditDate(e.target.value)}
                className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm"
              />
            </label>
          )}

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Internal note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="mt-1 w-full border border-slate-200 rounded-md px-3 py-2 text-sm"
              placeholder="How this was resolved…"
            />
          </label>

          {err && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              {err}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 flex items-center justify-between">
          <button
            onClick={() => void submit('withdraw')}
            disabled={submitting}
            className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900 flex items-center gap-1"
          >
            <Undo2 className="w-4 h-4" /> Withdraw
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm rounded-md border border-slate-200 text-slate-700"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit('resolve')}
              disabled={submitting}
              className="px-4 py-2 text-sm rounded-md bg-slate-900 text-white hover:bg-slate-800 flex items-center gap-1"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : mode === 'rejected' ? (
                <XCircle className="w-4 h-4" />
              ) : (
                <CheckCircle className="w-4 h-4" />
              )}
              {mode === 'rejected' ? 'Reject' : 'Resolve'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
