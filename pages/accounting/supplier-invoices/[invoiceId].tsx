/**
 * Supplier Invoice Detail Page
 * PRD-060 Phase 2: View invoice, approve, match, cancel
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Receipt, Loader2, AlertCircle, CheckCircle2,
  XCircle, Link2, FileText, Pencil, Save,
} from 'lucide-react';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    pending_approval: 'bg-amber-500/20 text-amber-400',
    approved: 'bg-blue-500/20 text-blue-400',
    partially_paid: 'bg-purple-500/20 text-purple-400',
    paid: 'bg-emerald-500/20 text-emerald-400',
    disputed: 'bg-red-500/20 text-red-400',
    cancelled: 'bg-gray-500/20 text-gray-500',
  };
  return (
    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${colors[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

type InvoiceWithItems = SupplierInvoice & { items: SupplierInvoiceItem[] };

export default function SupplierInvoiceDetailPage() {
  const router = useRouter();
  const { invoiceId } = router.query;
  const [invoice, setInvoice] = useState<InvoiceWithItems | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({ invoiceNumber: '', dueDate: '', paymentTerms: '', notes: '' });

  useEffect(() => {
    if (!invoiceId) return;
    loadInvoice();
  }, [invoiceId]);

  const loadInvoice = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`/api/accounting/supplier-invoices-detail?id=${invoiceId}`);
      const json = await res.json();
      setInvoice(json.data || json);
    } catch {
      setError('Failed to load invoice');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAction = async (action: string) => {
    if (!invoiceId) return;
    setActionLoading(action);
    try {
      const res = await fetch('/api/accounting/supplier-invoices-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, invoiceId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Action failed');
      }
      await loadInvoice();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading('');
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
        </div>
      </AppLayout>
    );
  }

  if (!invoice) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
            <p className="text-[var(--ff-text-secondary)]">{error || 'Invoice not found'}</p>
            <Link href="/accounting/supplier-invoices" className="text-sm text-emerald-600 mt-2 inline-block">
              Back to invoices
            </Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  const canEdit = invoice.status === 'draft' || invoice.status === 'pending_approval';
  const canApprove = canEdit;
  const canCancel = invoice.status !== 'paid' && invoice.status !== 'partially_paid' && invoice.status !== 'cancelled';
  const canMatch = !!invoice.purchaseOrderId;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/supplier-invoices" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-emerald-600 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Supplier Invoices
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10">
                <Receipt className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{invoice.invoiceNumber}</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{invoice.supplierName}</p>
              </div>
              <StatusBadge status={invoice.status} />
            </div>
            <div className="flex items-center gap-2">
              {canEdit && !editing && (
                <button onClick={() => { setEditing(true); setEditForm({ invoiceNumber: invoice.invoiceNumber, dueDate: invoice.dueDate || '', paymentTerms: invoice.paymentTerms || '', notes: invoice.notes || '' }); }}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 text-sm font-medium">
                  <Pencil className="h-4 w-4" />Edit
                </button>
              )}
              {editing && (
                <button onClick={async () => { setActionLoading('save'); try { await fetch('/api/accounting/supplier-invoices-detail', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: invoiceId, ...editForm }) }); setEditing(false); await loadInvoice(); } catch { setError('Save failed'); } setActionLoading(''); }} disabled={!!actionLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
                  <Save className="h-4 w-4" />{actionLoading === 'save' ? 'Saving...' : 'Save'}
                </button>
              )}
              {canMatch && (
                <button onClick={() => handleAction('match')} disabled={!!actionLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
                  <Link2 className="h-4 w-4" />{actionLoading === 'match' ? 'Matching...' : '3-Way Match'}
                </button>
              )}
              {canApprove && (
                <button onClick={() => handleAction('approve')} disabled={!!actionLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
                  <CheckCircle2 className="h-4 w-4" />{actionLoading === 'approve' ? 'Approving...' : 'Approve & Post GL'}
                </button>
              )}
              {canCancel && (
                <button onClick={() => handleAction('cancel')} disabled={!!actionLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 border border-red-500/50 text-red-400 rounded-lg hover:bg-red-500/10 text-sm font-medium disabled:opacity-50">
                  <XCircle className="h-4 w-4" />Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        {error && (
          <div className="mx-6 mt-4 flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" />{error}
          </div>
        )}

        <div className="p-6 space-y-6">
          {/* Details Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Invoice Date</p>
              <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{invoice.invoiceDate}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Due Date</p>
              {editing ? <input type="date" value={editForm.dueDate} onChange={e => setEditForm(p => ({ ...p, dueDate: e.target.value }))} className="ff-input mt-1 text-sm w-full" />
                : <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{invoice.dueDate || '-'}</p>}
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Payment Terms</p>
              {editing ? <input value={editForm.paymentTerms} onChange={e => setEditForm(p => ({ ...p, paymentTerms: e.target.value }))} className="ff-input mt-1 text-sm w-full" />
                : <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{invoice.paymentTerms || '-'}</p>}
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">PO Number</p>
              <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{invoice.poNumber || '-'}</p>
            </div>
            {[
              { label: 'Subtotal', value: formatCurrency(invoice.subtotal) },
              { label: 'VAT', value: `${formatCurrency(invoice.taxAmount)} (${invoice.taxRate}%)` },
              { label: 'Total', value: formatCurrency(invoice.totalAmount), highlight: true },
              { label: 'Balance', value: formatCurrency(invoice.balance), highlight: invoice.balance > 0 },
            ].map((item, i) => (
              <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{item.label}</p>
                <p className={`text-lg font-semibold mt-1 ${item.highlight ? 'text-emerald-500' : 'text-[var(--ff-text-primary)]'}`}>{item.value}</p>
              </div>
            ))}
          </div>

          {/* Line Items */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
              <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Line Items</h3>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Description</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Qty</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Unit Price</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Tax</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Line Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-light)]">
                {(invoice.items || []).map(item => (
                  <tr key={item.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                    <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">{item.description}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{item.quantity}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(item.unitPrice)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(item.taxAmount)}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-medium text-[var(--ff-text-primary)]">{formatCurrency(item.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)]">
                  <td colSpan={3}></td>
                  <td className="px-4 py-3 text-sm font-medium text-right text-[var(--ff-text-secondary)]">Total:</td>
                  <td className="px-4 py-3 text-sm text-right font-mono font-bold text-emerald-500">{formatCurrency(invoice.totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Notes */}
          {invoice.notes && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Notes</p>
              <p className="text-sm text-[var(--ff-text-secondary)]">{invoice.notes}</p>
            </div>
          )}

          {/* GL Journal Link */}
          {invoice.glJournalEntryId && (
            <Link
              href={`/accounting/journal-entries/${invoice.glJournalEntryId}`}
              className="inline-flex items-center gap-2 text-sm text-emerald-600 hover:text-emerald-700"
            >
              <FileText className="h-4 w-4" /> View GL Journal Entry
            </Link>
          )}

          {/* Documents */}
          <AccountingDocumentPanel
            entityType="supplier_invoice"
            entityId={invoiceId as string}
            allowedTypes={[
              { value: 'invoice', label: 'Invoice' },
              { value: 'receipt', label: 'Receipt' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </div>
      </div>
    </AppLayout>
  );
}
