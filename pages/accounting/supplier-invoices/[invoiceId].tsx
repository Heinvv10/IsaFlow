/**
 * Supplier Invoice Detail Page
 * PRD-060 Phase 2: View invoice, approve, match, cancel.
 * Actions grouped by workflow: Documents / Pay / Accounting / More.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Receipt, Loader2, AlertCircle, FileText } from 'lucide-react';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { ThreeWayMatchPanel } from '@/components/accounting/ap/ThreeWayMatchPanel';
import { MarkVatDeclaredElsewhereButton } from '@/components/accounting/sars/MarkVatDeclaredElsewhereButton';
import { InvoiceActionBar } from '@/components/invoices/InvoiceActionBar';
import { SupplierInvoiceSummary } from '@/components/invoices/SupplierInvoiceSummary';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { buildInvoiceTrail } from '@/components/accounting/invoiceReturnContext';
import { useSupplierInvoiceActions } from '@/modules/accounting/hooks/useSupplierInvoiceActions';
import { notifyLateClaims } from '@/components/accounting/lateClaimNotice';
import { notifyPostingWarnings, type PostingWarningsBody } from '@/components/accounting/postingWarningsNotice';
import { SupplierInvoiceApprovalPanel } from '@/components/accounting/ap/SupplierInvoiceApprovalPanel';
import type { DocumentApprovalState } from '@/modules/accounting/types/approval.types';

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

type InvoiceWithItems = SupplierInvoice & { items: SupplierInvoiceItem[]; approval?: DocumentApprovalState | null };

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
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/supplier-invoices-detail?id=${invoiceId}`);
      await assertOk(res, 'Could not load the invoice - try again');
      const json = await res.json();
      setInvoice(json.data || json);
    } catch (err) {
      setInvoice(null);
      setError(apiErrorMessage(err, 'Could not load the invoice - try again'));
    } finally {
      setIsLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    if (!invoiceId) return;
    void loadInvoice();
  }, [invoiceId, loadInvoice]);

  const handleAction = useCallback(async (action: string) => {
    if (!invoiceId) return;
    setActionLoading(action);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, invoiceId }),
      });
      // R-035: 409 is the approval gate — reload so the page offers Submit for approval.
      if (!res.ok) {
        if (res.status === 409) await loadInvoice();
        await assertOk(res, 'Could not complete that action - try again'); // throws: the response is not ok
        return;
      }
      const json = await res.json() as PostingWarningsBody;
      notifyLateClaims(json); // approve: VAT claimed in a later period (s16(3))
      notifyPostingWarnings(json); // approve: a cost centre on the bill that was not applied
      await loadInvoice();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not complete that action - try again'));
    } finally {
      setActionLoading('');
    }
  }, [invoiceId, loadInvoice]);

  const handleSaveEdit = async () => {
    setActionLoading('save');
    setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices-detail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, ...editForm }),
      });
      await assertOk(res, 'Could not save the invoice - try again');
      setEditing(false);
      await loadInvoice();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the invoice - try again'));
    } finally {
      setActionLoading('');
    }
  };

  const { groups, overflowActions } = useSupplierInvoiceActions(
    invoice ? {
      invoiceId: invoiceId as string, invoice, actionLoading, editing,
      onStartEdit: () => { setEditing(true); setEditForm({ invoiceNumber: invoice.invoiceNumber, dueDate: invoice.dueDate || '', paymentTerms: invoice.paymentTerms || '', notes: invoice.notes || '' }); },
      onSaveEdit: () => { void handleSaveEdit(); },
      onAction: (action) => { void handleAction(action); },
      onShowCancelConfirm: () => setShowCancelConfirm(true),
    } : null,
  );

  if (isLoading) return <AppLayout><div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div></AppLayout>;
  if (!invoice) return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Invoice not found'}</p>
          <Link href="/accounting/supplier-invoices" className="text-sm text-teal-600 mt-2 inline-block">Back to invoices</Link>
        </div>
      </div>
    </AppLayout>
  );

  const trail = buildInvoiceTrail('supplier', router.query, invoice.supplierName, invoice.invoiceNumber);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Breadcrumb items={trail.items} className="mb-3" />
          <Link href={trail.back.href} className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-600 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to {trail.back.label}
          </Link>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><Receipt className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{invoice.invoiceNumber}</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{invoice.supplierName}</p>
              </div>
              <StatusBadge status={invoice.status} />
            </div>
            <InvoiceActionBar groups={groups} overflowActions={overflowActions} />
          </div>
        </div>

        {error && <div className="mx-6 mt-4 flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm"><AlertCircle className="h-4 w-4" />{error}</div>}
        <SupplierInvoiceApprovalPanel invoiceId={invoiceId as string} approval={invoice.approval} onChanged={loadInvoice} />

        <div className="p-6 space-y-6">
          <SupplierInvoiceSummary
            invoiceDate={invoice.invoiceDate}
            dueDate={invoice.dueDate}
            paymentTerms={invoice.paymentTerms}
            poNumber={invoice.poNumber}
            subtotal={invoice.subtotal}
            taxAmount={invoice.taxAmount}
            taxRate={invoice.taxRate}
            totalAmount={invoice.totalAmount}
            balance={invoice.balance}
            notes={invoice.notes}
            items={invoice.items}
            editing={editing}
            editForm={editForm}
            onEditFormChange={(patch) => setEditForm(p => ({ ...p, ...patch }))}
          />

          {/* GL Journal link — body anchor for discoverability */}
          {invoice.glJournalEntryId && (
            <Link href={`/accounting/journal-entries/${invoice.glJournalEntryId}`} className="inline-flex items-center gap-2 text-sm text-teal-600 hover:text-teal-700">
              <FileText className="h-4 w-4" /> View GL Journal Entry
            </Link>
          )}
          <MarkVatDeclaredElsewhereButton
            kind="supplier" invoiceId={invoiceId as string}
            glJournalEntryId={invoice.glJournalEntryId || null} taxAmount={invoice.taxAmount}
            onMarked={() => void loadInvoice()}
          />

          <ThreeWayMatchPanel invoiceId={invoiceId as string} />

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

        <ConfirmDialog
          open={showCancelConfirm}
          title="Cancel Invoice?"
          message={<>This will cancel <strong>{invoice.invoiceNumber}</strong>. This action cannot be undone.</>}
          acceptLabel={actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel Invoice'}
          cancelLabel="Keep Invoice"
          tone="destructive"
          loading={actionLoading === 'cancel'}
          onAccept={() => { setShowCancelConfirm(false); void handleAction('cancel'); }}
          onCancel={() => setShowCancelConfirm(false)}
        />
      </div>
    </AppLayout>
  );
}
