/**
 * Credit Note Detail Page
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  approved: 'bg-emerald-500/20 text-emerald-400',
  applied: 'bg-blue-500/20 text-blue-400',
  cancelled: 'bg-red-500/20 text-red-400',
};

interface CreditNote {
  id: string; creditNoteNumber: string; type: string; clientId?: string; clientName?: string;
  supplierId?: string; supplierName?: string; invoiceNumber?: string;
  creditDate: string; reason?: string; subtotal: number; taxRate: number;
  taxAmount: number; totalAmount: number; status: string; glJournalEntryId?: string;
  approvedBy?: string; approvedAt?: string; createdAt: string;
}

export default function CreditNoteDetailPage() {
  const router = useRouter();
  const { creditNoteId } = router.query;
  const [note, setNote] = useState<CreditNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');

  useEffect(() => {
    if (!creditNoteId) return;
    setLoading(true);
    fetch(`/api/accounting/credit-notes?id=${creditNoteId}`)
      .then(r => r.json())
      .then(json => setNote(json.data || json))
      .catch(() => setError('Failed to load'))
      .finally(() => setLoading(false));
  }, [creditNoteId]);

  const handleAction = async (action: string) => {
    setActionLoading(action);
    setError('');
    try {
      const res = await fetch('/api/accounting/credit-notes-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, creditNoteId }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Failed'); }
      const json = await res.json();
      setNote(json.data || json);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setActionLoading(''); }
  };

  if (loading) return <AppLayout><div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="h-8 w-8 animate-spin text-blue-500" /></div></AppLayout>;
  if (!note) return <AppLayout><div className="flex items-center justify-center min-h-[60vh] flex-col"><AlertCircle className="h-8 w-8 text-red-400 mb-2" /><p className="text-[var(--ff-text-secondary)]">{error || 'Not found'}</p></div></AppLayout>;

  const entityName = note.type === 'customer' ? note.clientName : note.supplierName;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/credit-notes" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Credit Notes
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10"><FileText className="h-6 w-6 text-orange-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{note.creditNoteNumber}</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{entityName} — {note.type} credit note</p>
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${STATUS_COLORS[note.status] || ''}`}>
                {note.status}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {note.status === 'draft' && (
                <button onClick={() => handleAction('approve')} disabled={!!actionLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-500 disabled:opacity-50">
                  <CheckCircle2 className="h-4 w-4" />{actionLoading === 'approve' ? 'Approving...' : 'Approve & Post GL'}
                </button>
              )}
              {note.status === 'draft' && (
                <button onClick={() => router.push('/accounting/credit-notes')} className="inline-flex items-center gap-1.5 px-3 py-2 border border-red-500/50 text-red-400 rounded-lg text-sm hover:bg-red-500/10">
                  <XCircle className="h-4 w-4" />Discard
                </button>
              )}
            </div>
          </div>
        </div>

        {error && <div className="mx-6 mt-4 flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm"><AlertCircle className="h-4 w-4" />{error}</div>}

        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Type', value: note.type },
              { label: 'Credit Date', value: note.creditDate?.split('T')[0] },
              { label: 'Invoice Ref', value: note.invoiceNumber || '—' },
              { label: 'VAT Rate', value: `${note.taxRate}%` },
              { label: 'Subtotal', value: fmt(Number(note.subtotal)) },
              { label: 'VAT', value: fmt(Number(note.taxAmount)) },
              { label: 'Total Amount', value: fmt(Number(note.totalAmount)), hl: true },
              { label: 'Created', value: note.createdAt?.split('T')[0] },
            ].map((c, i) => (
              <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{c.label}</p>
                <p className={`text-lg font-semibold mt-1 ${c.hl ? 'text-orange-400' : 'text-[var(--ff-text-primary)]'}`}>{c.value}</p>
              </div>
            ))}
          </div>

          {note.reason && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Reason</p>
              <p className="text-sm text-[var(--ff-text-secondary)]">{note.reason}</p>
            </div>
          )}

          {note.approvedBy && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Approved</p>
              <p className="text-sm text-[var(--ff-text-secondary)]">By {note.approvedBy} on {note.approvedAt?.split('T')[0]}</p>
            </div>
          )}

          {note.glJournalEntryId && (
            <Link href={`/accounting/journal-entries/${note.glJournalEntryId}`}
              className="inline-flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300">
              <FileText className="h-4 w-4" /> View GL Journal Entry
            </Link>
          )}

          {/* Documents */}
          <AccountingDocumentPanel
            entityType="credit_note"
            entityId={creditNoteId as string}
            allowedTypes={[
              { value: 'credit_note_doc', label: 'Credit Note' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </div>
      </div>
    </AppLayout>
  );
}
