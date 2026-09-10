/**
 * Resolve / withdraw modal for a customer invoice dispute.
 * Split out of pages/accounting/disputes/index.tsx (300-line limit).
 */

import { useState } from 'react';
import { Loader2, CheckCircle, XCircle, Undo2 } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import type { DisputeRow } from '@/components/accounting/disputes/types';

type ResolveMode = 'resolve_with_credit' | 'resolve_no_credit' | 'rejected';

export function ResolveModal({
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
