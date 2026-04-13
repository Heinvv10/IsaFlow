/**
 * Credit Note Detail Page
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, AlertCircle, CheckCircle2, XCircle, Download, CreditCard, X } from 'lucide-react';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  approved: 'bg-teal-500/20 text-teal-400',
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

interface OutstandingInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: number;
  amountPaid: number;
  outstanding: number;
}

export default function CreditNoteDetailPage() {
  const router = useRouter();
  const { creditNoteId } = router.query;
  const [note, setNote] = useState<CreditNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');

  // Apply to invoice modal state
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [invoices, setInvoices] = useState<OutstandingInvoice[]>([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState('');

  useEffect(() => {
    if (!creditNoteId) return;
    setLoading(true);
    apiFetch(`/api/accounting/credit-notes?id=${creditNoteId}`)
      .then(r => r.json())
      .then(json => setNote(json.data || json))
      .catch(() => setError('Failed to load'))
      .finally(() => setLoading(false));
  }, [creditNoteId]);

  async function openApplyModal() {
    if (!note?.clientId) return;
    setShowApplyModal(true);
    setSelectedInvoiceId('');
    setInvoicesLoading(true);
    try {
      const res = await apiFetch(
        `/api/accounting/customer-invoices-list?client_id=${note.clientId}&status=approved&status=sent&status=partially_paid&status=overdue&limit=50`
      );
      const json = await res.json();
      const rows = json.data || json.invoices || json || [];
      setInvoices(
        (rows as Record<string, unknown>[]).map(r => ({
          id: String(r.id),
          invoiceNumber: String(r.invoice_number || r.invoiceNumber || ''),
          invoiceDate: String(r.invoice_date || r.invoiceDate || ''),
          totalAmount: Number(r.total_amount ?? r.totalAmount ?? 0),
          amountPaid: Number(r.amount_paid ?? r.amountPaid ?? 0),
          outstanding: Number(r.total_amount ?? r.totalAmount ?? 0) - Number(r.amount_paid ?? r.amountPaid ?? 0),
        })).filter(i => i.outstanding > 0.01)
      );
    } catch {
      setInvoices([]);
    } finally {
      setInvoicesLoading(false);
    }
  }

  const handleAction = async (action: string, extra?: Record<string, string>) => {
    setActionLoading(action);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/credit-notes-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, creditNoteId, ...extra }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Failed'); }
      const json = await res.json();
      setNote(json.data || json);
      if (action === 'apply') setShowApplyModal(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setActionLoading(''); }
  };

  if (loading) return <AppLayout><div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="h-8 w-8 animate-spin text-blue-500" /></div></AppLayout>;
  if (!note) return <AppLayout><div className="flex items-center justify-center min-h-[60vh] flex-col"><AlertCircle className="h-8 w-8 text-red-400 mb-2" /><p className="text-[var(--ff-text-secondary)]">{error || 'Not found'}</p></div></AppLayout>;

  const entityName = note.type === 'customer' ? note.clientName : note.supplierName;
  const canApply = note.status === 'approved' && note.type === 'customer';

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
              <button onClick={() => window.open(`/api/accounting/credit-note-pdf?creditNoteId=${creditNoteId}`, '_blank')}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-500">
                <Download className="h-4 w-4" />Download PDF
              </button>
              {canApply && (
                <button onClick={openApplyModal} disabled={!!actionLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 disabled:opacity-50">
                  <CreditCard className="h-4 w-4" />Apply to Invoice
                </button>
              )}
              {note.status === 'draft' && (
                <button onClick={() => handleAction('approve')} disabled={!!actionLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-500 disabled:opacity-50">
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
              { label: 'Subtotal', value: formatCurrency(Number(note.subtotal)) },
              { label: 'VAT', value: formatCurrency(Number(note.taxAmount)) },
              { label: 'Total Amount', value: formatCurrency(Number(note.totalAmount)), hl: true },
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

      {/* Apply to Invoice Modal */}
      {showApplyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-xl w-full max-w-lg mx-4 shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--ff-border-light)]">
              <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">Apply Credit Note to Invoice</h2>
              <button onClick={() => setShowApplyModal(false)} className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)]">
                <X className="h-4 w-4 text-[var(--ff-text-secondary)]" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Applying <span className="text-orange-400 font-semibold">{formatCurrency(Number(note.totalAmount))}</span> credit note <span className="font-mono text-[var(--ff-text-primary)]">{note.creditNoteNumber}</span> to an outstanding invoice.
              </p>
              {invoicesLoading ? (
                <div className="flex justify-center py-6"><Loader2 className="h-6 w-6 animate-spin text-blue-400" /></div>
              ) : invoices.length === 0 ? (
                <p className="text-sm text-[var(--ff-text-tertiary)] text-center py-4">No outstanding invoices found for this customer.</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {invoices.map(inv => (
                    <label key={inv.id}
                      className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedInvoiceId === inv.id
                          ? 'border-blue-500 bg-blue-500/10'
                          : 'border-[var(--ff-border-light)] hover:border-blue-500/50'
                      }`}>
                      <div className="flex items-center gap-3">
                        <input type="radio" name="invoice" value={inv.id}
                          checked={selectedInvoiceId === inv.id}
                          onChange={() => setSelectedInvoiceId(inv.id)}
                          className="accent-blue-500" />
                        <div>
                          <p className="text-sm font-mono text-[var(--ff-text-primary)]">{inv.invoiceNumber}</p>
                          <p className="text-xs text-[var(--ff-text-tertiary)]">{formatDate(inv.invoiceDate)}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-red-400">{formatCurrency(inv.outstanding)} outstanding</p>
                        <p className="text-xs text-[var(--ff-text-tertiary)]">of {formatCurrency(inv.totalAmount)}</p>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {error && <p className="text-sm text-red-400">{error}</p>}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--ff-border-light)]">
              <button onClick={() => setShowApplyModal(false)}
                className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
                Cancel
              </button>
              <button
                onClick={() => handleAction('apply', { invoiceId: selectedInvoiceId })}
                disabled={!selectedInvoiceId || actionLoading === 'apply'}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-500 disabled:opacity-50">
                {actionLoading === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                {actionLoading === 'apply' ? 'Applying...' : 'Apply Credit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
