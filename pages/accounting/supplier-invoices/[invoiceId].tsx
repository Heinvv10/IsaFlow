/**
 * Supplier Invoice Detail Page
 * PRD-060 Phase 2: View invoice, approve, match, cancel.
 * Actions grouped by workflow: Documents / Pay / Accounting / More.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Receipt, Loader2, AlertCircle, CheckCircle2,
  XCircle, Link2, FileText, Pencil, Save, Download, CreditCard,
} from 'lucide-react';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import { ThreeWayMatchPanel } from '@/components/accounting/ap/ThreeWayMatchPanel';
import { InvoiceActionBar } from '@/components/invoices/InvoiceActionBar';
import type { InvoiceActionGroup } from '@/components/invoices/InvoiceActionBar';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-gray-500/20 text-gray-400',
    pending_approval: 'bg-amber-500/20 text-amber-400',
    approved: 'bg-blue-500/20 text-blue-400',
    partially_paid: 'bg-purple-500/20 text-purple-400',
    paid: 'bg-teal-500/20 text-teal-400',
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
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const loadInvoice = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/supplier-invoices-detail?id=${invoiceId}`);
      const json = await res.json();
      setInvoice(json.data || json);
    } catch {
      setError('Failed to load invoice');
    } finally {
      setIsLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    if (!invoiceId) return;
    void loadInvoice();
  }, [invoiceId, loadInvoice]);

  const handleAction = async (action: string) => {
    if (!invoiceId) return;
    setActionLoading(action);
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices-action', {
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

  const handleSaveEdit = async () => {
    setActionLoading('save');
    try {
      await apiFetch('/api/accounting/supplier-invoices-detail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, ...editForm }),
      });
      setEditing(false);
      await loadInvoice();
    } catch {
      setError('Save failed');
    }
    setActionLoading('');
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
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
            <Link href="/accounting/supplier-invoices" className="text-sm text-teal-600 mt-2 inline-block">
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
  const canRecordPayment = ['approved', 'partially_paid'].includes(invoice.status) && invoice.balance > 0;

  // ── Action groups ────────────────────────────────────────────────────────────

  const documentsGroup: InvoiceActionGroup = {
    label: 'Documents',
    actions: [
      {
        label: 'Download PDF',
        icon: <Download className="h-4 w-4" />,
        onClick: () => {
          window.open(`/api/accounting/supplier-invoice-pdf?invoiceId=${String(invoiceId)}`, '_blank');
        },
        variant: 'secondary',
      },
      ...(canEdit && !editing
        ? [{
            label: 'Edit',
            icon: <Pencil className="h-4 w-4" />,
            onClick: () => {
              setEditing(true);
              setEditForm({
                invoiceNumber: invoice.invoiceNumber,
                dueDate: invoice.dueDate || '',
                paymentTerms: invoice.paymentTerms || '',
                notes: invoice.notes || '',
              });
            },
            variant: 'secondary' as const,
          }]
        : []),
      ...(editing
        ? [{
            label: actionLoading === 'save' ? 'Saving...' : 'Save',
            icon: <Save className="h-4 w-4" />,
            onClick: () => { void handleSaveEdit(); },
            disabled: !!actionLoading,
            loading: actionLoading === 'save',
            variant: 'primary' as const,
          }]
        : []),
    ],
  };

  const payGroup: InvoiceActionGroup = {
    label: 'Pay',
    actions: [
      ...(canMatch
        ? [{
            label: actionLoading === 'match' ? 'Matching...' : '3-Way Match',
            icon: <Link2 className="h-4 w-4" />,
            onClick: () => { void handleAction('match'); },
            disabled: !!actionLoading,
            loading: actionLoading === 'match',
            variant: 'secondary' as const,
          }]
        : []),
      ...(canApprove
        ? [{
            label: actionLoading === 'approve' ? 'Approving...' : 'Approve & Post GL',
            icon: <CheckCircle2 className="h-4 w-4" />,
            onClick: () => { void handleAction('approve'); },
            disabled: !!actionLoading,
            loading: actionLoading === 'approve',
            variant: 'primary' as const,
          }]
        : []),
      ...(canRecordPayment
        ? [{
            label: 'Record Payment',
            icon: <CreditCard className="h-4 w-4" />,
            onClick: () => {
              void router.push(
                `/accounting/supplier-payments/new?invoiceId=${String(invoiceId)}&supplierId=${invoice.supplierId}&amount=${invoice.balance.toFixed(2)}`,
              );
            },
            variant: 'primary' as const,
          }]
        : []),
    ],
  };

  const accountingGroup: InvoiceActionGroup = {
    label: 'Accounting',
    actions: invoice.glJournalEntryId
      ? [{
          label: 'View GL Entry',
          icon: <FileText className="h-4 w-4" />,
          onClick: () => { void router.push(`/accounting/journal-entries/${invoice.glJournalEntryId}`); },
          variant: 'secondary' as const,
        }]
      : [],
  };

  const overflowActions: ActionMenuItem[] = [
    ...(canCancel
      ? [{
          label: 'Cancel Invoice',
          icon: <XCircle className="h-4 w-4" />,
          onClick: () => { setShowCancelConfirm(true); },
          tone: 'destructive' as const,
        }]
      : []),
  ];

  const activeGroups = [documentsGroup, payGroup, accountingGroup].filter(
    g => g.actions.length > 0,
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link
            href="/accounting/supplier-invoices"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-600 mb-3"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Supplier Invoices
          </Link>

          <div className="flex items-end justify-between gap-4 flex-wrap">
            {/* Title block */}
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Receipt className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{invoice.invoiceNumber}</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{invoice.supplierName}</p>
              </div>
              <StatusBadge status={invoice.status} />
            </div>

            {/* Grouped action bar */}
            <InvoiceActionBar
              groups={activeGroups}
              overflowActions={overflowActions}
            />
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
              {editing
                ? <input
                    type="date"
                    name="dueDate"
                    value={editForm.dueDate}
                    onChange={e => setEditForm(p => ({ ...p, dueDate: e.target.value }))}
                    className="ff-input mt-1 text-sm w-full"
                  />
                : <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{invoice.dueDate || '-'}</p>
              }
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Payment Terms</p>
              {editing
                ? <input
                    name="paymentTerms"
                    value={editForm.paymentTerms}
                    onChange={e => setEditForm(p => ({ ...p, paymentTerms: e.target.value }))}
                    className="ff-input mt-1 text-sm w-full"
                  />
                : <p className="text-lg font-semibold mt-1 text-[var(--ff-text-primary)]">{invoice.paymentTerms || '-'}</p>
              }
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
                <p className={`text-lg font-semibold mt-1 ${item.highlight ? 'text-teal-500' : 'text-[var(--ff-text-primary)]'}`}>
                  {item.value}
                </p>
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
                  <td className="px-4 py-3 text-sm text-right font-mono font-bold text-teal-500">{formatCurrency(invoice.totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Notes (inline edit supported) */}
          {(invoice.notes || editing) && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Notes</p>
              {editing
                ? <textarea
                    name="notes"
                    value={editForm.notes}
                    onChange={e => setEditForm(p => ({ ...p, notes: e.target.value }))}
                    rows={3}
                    className="ff-input mt-1 text-sm w-full resize-none"
                  />
                : <p className="text-sm text-[var(--ff-text-secondary)]">{invoice.notes}</p>
              }
            </div>
          )}

          {/* GL Journal Link */}
          {invoice.glJournalEntryId && (
            <Link
              href={`/accounting/journal-entries/${invoice.glJournalEntryId}`}
              className="inline-flex items-center gap-2 text-sm text-teal-600 hover:text-teal-700"
            >
              <FileText className="h-4 w-4" /> View GL Journal Entry
            </Link>
          )}

          {/* 3-Way Match */}
          <ThreeWayMatchPanel invoiceId={invoiceId as string} />

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

        {/* Cancel confirmation */}
        {showCancelConfirm && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={() => setShowCancelConfirm(false)}
          >
            <div
              className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] shadow-2xl w-full max-w-sm mx-4 p-6"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 rounded-full bg-red-500/10">
                  <XCircle className="h-5 w-5 text-red-400" />
                </div>
                <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Cancel Invoice?</h3>
              </div>
              <p className="text-sm text-[var(--ff-text-secondary)] mb-6">
                This will cancel <strong>{invoice.invoiceNumber}</strong>. This action cannot be undone.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg border border-[var(--ff-border-light)]"
                >
                  Keep Invoice
                </button>
                <button
                  onClick={() => { setShowCancelConfirm(false); void handleAction('cancel'); }}
                  disabled={!!actionLoading}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-500 disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  {actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel Invoice'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
