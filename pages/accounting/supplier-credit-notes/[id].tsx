/**
 * Supplier Credit Note Detail Page
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, FileText, Loader2, AlertCircle,
  CheckCircle2, RotateCcw, Pencil, Trash2,
} from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import type { CreditNote } from '@/modules/accounting/types/ar.types';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  approved: 'bg-teal-500/20 text-teal-400',
  applied: 'bg-blue-500/20 text-blue-400',
  cancelled: 'bg-red-500/20 text-red-400',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${STATUS_COLORS[status] ?? 'bg-gray-500/20 text-gray-400'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function toDateStr(val: Date | string | null | undefined): string {
  if (!val) return '—';
  if (val instanceof Date) return val.toLocaleDateString('en-ZA');
  const s = String(val);
  return s.split('T')[0] ?? s;
}

export default function SupplierCreditNoteDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const [note, setNote] = useState<CreditNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');

  useEffect(() => {
    if (!id || typeof id !== 'string') return;
    setLoading(true);
    apiFetch(`/api/accounting/supplier-credit-notes?id=${id}`)
      .then(r => r.json())
      .then((json: { data?: CreditNote } | CreditNote) => {
        const data = (json as { data?: CreditNote }).data ?? (json as CreditNote);
        setNote(data);
      })
      .catch(() => setError('Failed to load supplier credit note'))
      .finally(() => setLoading(false));
  }, [id]);

  const doAction = async (action: 'post' | 'reverse') => {
    if (!note) return;
    setActionLoading(action);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-credit-notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: note.id, action }),
      });
      const json = await res.json() as { error?: { message?: string }; data?: CreditNote };
      if (!res.ok) throw new Error(json?.error?.message ?? 'Action failed');
      setNote(json.data ?? (json as unknown as CreditNote));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading('');
    }
  };

  const doDelete = async () => {
    if (!note || !confirm('Delete this draft credit note? This cannot be undone.')) return;
    setActionLoading('delete');
    setError('');
    try {
      // Draft deletion via cancel action
      const res = await apiFetch('/api/accounting/credit-notes-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', creditNoteId: note.id }),
      });
      if (!res.ok) {
        const j = await res.json() as { error?: { message?: string } };
        throw new Error(j?.error?.message ?? 'Delete failed');
      }
      await router.push('/accounting/supplier-credit-notes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setActionLoading('');
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
        </div>
      </AppLayout>
    );
  }

  if (!note) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Credit note not found'}</p>
          <Link href="/accounting/supplier-credit-notes" className="text-sm text-orange-400 hover:text-orange-300">
            Back to Supplier Credit Notes
          </Link>
        </div>
      </AppLayout>
    );
  }

  const infoCards = [
    { label: 'CN Number', value: note.creditNoteNumber },
    { label: 'Supplier', value: note.supplierName ?? '—' },
    { label: 'Credit Date', value: toDateStr(note.creditDate) },
    { label: 'Invoice Ref', value: note.invoiceNumber ?? '—' },
    { label: 'Reason', value: note.reason ?? '—' },
    { label: 'Created', value: toDateStr(note.createdAt) },
  ];

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link
            href="/accounting/supplier-credit-notes"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-orange-400 mb-3"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Supplier Credit Notes
          </Link>

          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <FileText className="h-6 w-6 text-orange-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  {note.creditNoteNumber}
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {note.supplierName ?? 'Unknown supplier'} — supplier credit note
                </p>
              </div>
              <StatusBadge status={note.status} />
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {note.status === 'draft' && (
                <>
                  <button
                    onClick={() => { void doAction('post'); }}
                    disabled={!!actionLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-500 disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {actionLoading === 'post' ? 'Posting...' : 'Post'}
                  </button>
                  <Link
                    href={`/accounting/supplier-credit-notes/new?edit=${note.id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg text-sm hover:bg-[var(--ff-bg-primary)]"
                  >
                    <Pencil className="h-4 w-4" /> Edit
                  </Link>
                  <button
                    onClick={() => { void doDelete(); }}
                    disabled={!!actionLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-2 border border-red-500/40 text-red-400 rounded-lg text-sm hover:bg-red-500/10 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                    {actionLoading === 'delete' ? 'Deleting...' : 'Delete'}
                  </button>
                </>
              )}
              {note.status === 'approved' && (
                <button
                  onClick={() => { void doAction('reverse'); }}
                  disabled={!!actionLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 border border-amber-500/40 text-amber-400 rounded-lg text-sm hover:bg-amber-500/10 disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" />
                  {actionLoading === 'reverse' ? 'Reversing...' : 'Reverse'}
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="mx-6 mt-4 flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error}
          </div>
        )}

        <div className="p-6 space-y-6">
          {/* Info cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {infoCards.map((c, i) => (
              <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase tracking-wide">{c.label}</p>
                <p className="text-sm font-semibold mt-1 text-[var(--ff-text-primary)]">{c.value}</p>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <h2 className="text-base font-semibold text-[var(--ff-text-primary)] mb-4">Totals</h2>
            <div className="space-y-2 max-w-xs ml-auto text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--ff-text-secondary)]">Subtotal (excl. VAT)</span>
                <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(Number(note.subtotal))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--ff-text-secondary)]">VAT ({note.taxRate}%)</span>
                <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(Number(note.taxAmount))}</span>
              </div>
              <div className="flex justify-between pt-2 border-t border-[var(--ff-border-light)] text-base font-semibold">
                <span className="text-[var(--ff-text-primary)]">Total</span>
                <span className="font-mono text-orange-400">{formatCurrency(Number(note.totalAmount))}</span>
              </div>
            </div>
          </div>

          {/* GL Journal link */}
          {note.glJournalEntryId && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <Link
                href={`/accounting/journal-entries/${note.glJournalEntryId}`}
                className="inline-flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300"
              >
                <FileText className="h-4 w-4" /> View GL Journal Entry
              </Link>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
