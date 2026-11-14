/**
 * Customer Invoice Detail Page
 * View invoice with line items, approve, send, cancel.
 * Actions grouped by workflow: Send / Collect / Accounting / More.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, AlertCircle, Pencil } from 'lucide-react';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import { CommentsPanel } from '@/components/accounting/comments/CommentsPanel';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { InvoiceActionBar } from '@/components/invoices/InvoiceActionBar';
import { InvoiceEmailModal } from '@/components/invoices/InvoiceEmailModal';
import { CustomerInvoiceSummary } from '@/components/invoices/CustomerInvoiceSummary';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RevokePaymentLinkDialog } from '@/components/invoices/RevokePaymentLinkDialog';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { buildInvoiceTrail } from '@/components/accounting/invoiceReturnContext';
import { useCustomerInvoiceActions } from '@/modules/accounting/hooks/useCustomerInvoiceActions';
import { MarkVatDeclaredElsewhereButton } from '@/components/accounting/sars/MarkVatDeclaredElsewhereButton';
import type { CustomerInvoiceDetail } from '@/modules/accounting/types/customerInvoice.types';
import { CUSTOMER_INVOICE_STATUS_COLORS } from '@/modules/accounting/types/customerInvoice.types';
import { InvoiceAdjacentNav, useAdjacentInvoices } from '@/components/invoices/InvoiceAdjacentNav';
import { DocumentApprovalPanel } from '@/components/accounting/approvals/DocumentApprovalPanel';
import { useInvoiceLinkActions } from '@/components/invoices/useInvoiceLinkActions';
import { invoiceSavesSettled, takeUnsavedLeave } from '@/lib/pendingInvoiceSaves';
import { approvalShown } from '@/components/accounting/customer-invoices/approveShown';
import { openInvoiceLoads } from '@/components/invoices/openInvoiceLoads';
import { rateText } from '@/modules/accounting/services/ar/customerInvoiceStaleView';
import { DueDateEditor } from '@/components/accounting/terms/DueDateEditor';

export default function CustomerInvoiceDetailPage() {
  const router = useRouter();
  const { invoiceId } = router.query;
  const [invoice, setInvoice] = useState<CustomerInvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailTo, setEmailTo] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailSuccess, setEmailSuccess] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const { prevId, nextId, loadAdjacent, clear: clearAdjacent } = useAdjacentInvoices();

  // The invoice the URL opens now (openInvoiceLoads): a load starts only for it, and is shown only if it is still open
  // and nothing newer started, so nothing (Email, Cancel…) is ever done to A from B's page.
  const [loads] = useState(openInvoiceLoads);
  const loadInvoice = useCallback(async (id: string) => {
    const mine = loads.begin(id);
    if (mine === null) return; // no longer the invoice open
    const current = () => loads.isCurrent(mine);
    setLoading(true);
    setError('');
    try {
      await invoiceSavesSettled(id); // an edit page's last save, sent as it closed, lands first
      const res = await apiFetch(`/api/accounting/customer-invoices-detail?id=${id}`);
      await assertOk(res, 'Could not load the invoice - try again');
      const json = await res.json();
      const shown = json.data || json;
      if (current()) { setInvoice(shown); const lost = takeUnsavedLeave(id, shown.invoice_number); if (lost) setError(lost.message); }
    } catch (err) {
      if (!current()) return;
      setInvoice(null); clearAdjacent();
      setError(apiErrorMessage(err, 'Could not load the invoice - try again'));
    } finally {
      if (current()) setLoading(false);
    }
  }, [loads, clearAdjacent]);
  const reloadOpen = useCallback(() => (invoice ? loadInvoice(invoice.id) : Promise.resolve()), [invoice, loadInvoice]);
  const { paymentLoading, linkCopied, portalUrl, portalLinkLoading, portalLinkCopied, handlePayNow, handleCopyPaymentLink, handleCopyPortalLink, reset: resetLinks } =
    useInvoiceLinkActions({ invoice, loadInvoice: reloadOpen, setError, isOpen: loads.isOpen });

  useEffect(() => {
    if (!invoiceId) return;
    loads.open(String(invoiceId));
    // Another invoice opened in place: nothing of the last one's stays (its email form and address, its questions).
    setShowEmailModal(false); setEmailTo(''); setEmailSuccess(''); setEmailSending(false); setShowCancelConfirm(false); setShowRevokeConfirm(false); setActionLoading('');
    resetLinks(); clearAdjacent();
    void loadInvoice(String(invoiceId));
    void loadAdjacent(String(invoiceId), loads.isOpen);
  }, [invoiceId, loads, loadInvoice, loadAdjacent, resetLinks, clearAdjacent]);

  const handleAction = useCallback(async (action: string) => {
    const actedOn = invoice?.id;
    if (!actedOn) return;
    setActionLoading(action);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The invoice shown, never the URL's (another may be loading). Approve carries what is on screen: anything stored
        // differently is refused (409 STALE_VIEW) and reloaded below.
        body: JSON.stringify(action === 'approve'
          ? { id: actedOn, action, ...approvalShown({ total: Number(invoice?.total_amount), currencyCode: invoice?.currency_code ?? 'ZAR', exchangeRate: Number(invoice?.exchange_rate ?? 1), approvalContentDigest: invoice.shown_digest }) }
          : { id: actedOn, action }),
      });
      // R-035: 409 is the approval gate — reload so the page offers Submit for approval — or STALE_VIEW: show what is stored.
      if (res.status === 409) await loadInvoice(actedOn);
      await assertOk(res, 'Could not complete that action - try again');
      await loadInvoice(actedOn);
    } catch (e) {
      if (loads.isOpen(actedOn)) setError(apiErrorMessage(e, 'Could not complete that action - try again')); // not A's on B
    } finally {
      if (loads.isOpen(actedOn)) setActionLoading('');
    }
  }, [invoice, loads, loadInvoice]);

  const handleSendEmail = async () => {
    const sentFor = invoice?.id;
    if (!emailTo.trim() || !sentFor) return;
    setEmailSending(true);
    setEmailSuccess('');
    try {
      const res = await apiFetch('/api/accounting/invoice-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId: sentFor, recipientEmail: emailTo.trim() }),
      });
      await assertOk(res, 'Could not send the invoice email - try again');
      const json = await res.json();
      if (!loads.isOpen(sentFor)) return;
      setEmailSuccess(json.data?.sent ? 'Invoice emailed successfully!' : (json.message || 'Email could not be sent.'));
      if (json.data?.sent) await loadInvoice(sentFor);
    } catch (e) {
      if (loads.isOpen(sentFor)) setError(apiErrorMessage(e, 'Could not send the invoice email - try again'));
    } finally { if (loads.isOpen(sentFor)) setEmailSending(false); }
  };


  const { groups, overflowActions } = useCustomerInvoiceActions(
    invoice ? {
      invoiceId: invoice.id, invoice, actionLoading, paymentLoading,
      portalLinkLoading, portalLinkCopied, linkCopied,
      onOpenEmailModal: () => { setEmailTo(invoice.client_email || invoice.email_sent_to || ''); setEmailSuccess(''); setShowEmailModal(true); },
      onCopyPortalLink: () => { void handleCopyPortalLink(); },
      onPayNow: () => { void handlePayNow(); },
      onCopyPaymentLink: () => { void handleCopyPaymentLink(); },
      onAction: (action) => { void handleAction(action); },
      onShowCancelConfirm: () => setShowCancelConfirm(true),
      onShowRevokeConfirm: () => setShowRevokeConfirm(true),
    } : null,
  );

  if (loading) return <AppLayout><div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="h-8 w-8 animate-spin text-blue-600 dark:text-blue-400" /></div></AppLayout>;
  if (!invoice) return <AppLayout><div className="flex items-center justify-center min-h-[60vh] flex-col"><AlertCircle className="h-8 w-8 text-red-400 mb-2" /><p className="text-[var(--ff-text-secondary)]">{error || 'Invoice not found'}</p></div></AppLayout>;

  const balance = Number(invoice.total_amount) - Number(invoice.amount_paid);
  const shownCurrency = (i: CustomerInvoiceDetail) => { const code = i.currency_code || 'ZAR'; return code === 'ZAR' ? code : `${code} at ${rateText(i.exchange_rate)}`; };
  const trail = buildInvoiceTrail('customer', router.query, invoice.client_name, invoice.invoice_number);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Breadcrumb items={trail.items} className="mb-3" />
          <div className="flex items-center justify-between mb-3">
            <Link href={trail.back.href} className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400">
              <ArrowLeft className="h-4 w-4" /> Back to {trail.back.label}
            </Link>
            <InvoiceAdjacentNav prevId={prevId} nextId={nextId}
              onGo={(id) => { void router.push(`/accounting/customer-invoices/${id}`); }} />
          </div>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><FileText className="h-6 w-6 text-blue-600 dark:text-blue-400" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{invoice.invoice_number}</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{invoice.client_name} — {invoice.project_name}</p>
                <p className="text-xs text-[var(--ff-text-secondary)]">Currency: {shownCurrency(invoice)}</p>
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${CUSTOMER_INVOICE_STATUS_COLORS[invoice.status] || ''}`}>{invoice.status.replace(/_/g, ' ')}</span>
              {invoice.status === 'draft' && (
                <Link
                  href={`/accounting/customer-invoices/edit/${invoice.id}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-amber-500/40 text-amber-500 hover:bg-amber-500/10 transition-colors"
                  title="Edit draft invoice"
                >
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Link>
              )}
            </div>
            <InvoiceActionBar groups={groups} overflowActions={overflowActions} />
          </div>
        </div>

        {error && <div className="mx-6 mt-4 flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm"><AlertCircle className="h-4 w-4" />{error}</div>}
        <DocumentApprovalPanel documentType="customer_invoice" documentId={invoice.id} noun="invoice"
          approval={invoice.approval} onChanged={reloadOpen} />
        {portalUrl && (
          <div className="mx-6 mt-3 flex items-center gap-2">
            <span className="text-xs text-[var(--ff-text-secondary)] shrink-0">Portal link:</span>
            <input readOnly value={portalUrl} className="flex-1 text-xs bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded px-2 py-1 text-teal-400 font-mono truncate" />
          </div>
        )}

        <div className="p-6 space-y-6">
          <CustomerInvoiceSummary
            invoiceDate={invoice.invoice_date}
            dueDate={invoice.due_date}
            billingPeriodStart={invoice.billing_period_start}
            billingPeriodEnd={invoice.billing_period_end}
            taxRate={invoice.tax_rate}
            subtotal={invoice.subtotal}
            taxAmount={invoice.tax_amount}
            totalAmount={invoice.total_amount}
            balance={balance}
            notes={invoice.notes}
            items={invoice.items}
            currencyCode={invoice.currency_code || 'ZAR'}
          />
          <DueDateEditor
            kind="invoice" invoiceId={invoice.id} status={invoice.status} balance={balance} invoiceDate={invoice.invoice_date}
            dueDate={invoice.due_date} dueDateSource={invoice.due_date_source} onSaved={reloadOpen}
          />
          {/* GL Journal link — body anchor for discoverability, matching supplier page */}
          {invoice.gl_journal_entry_id && (
            <Link href={`/accounting/journal-entries/${invoice.gl_journal_entry_id}`} className="inline-flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300">
              <FileText className="h-4 w-4" /> View GL Journal Entry
            </Link>
          )}
          <MarkVatDeclaredElsewhereButton
            kind="customer" invoiceId={invoice.id}
            glJournalEntryId={invoice.gl_journal_entry_id || null} taxAmount={invoice.tax_amount}
            onMarked={() => void reloadOpen()}
          />
          <AccountingDocumentPanel
            entityType="customer_invoice"
            entityId={invoice.id}
            allowedTypes={[
              { value: 'invoice', label: 'Invoice PDF' },
              { value: 'other', label: 'Other' },
            ]}
          />

          <CommentsPanel recordType="customer_invoice" recordId={invoice.id} />
        </div>

        <InvoiceEmailModal
          open={showEmailModal}
          invoiceNumber={invoice.invoice_number}
          emailTo={emailTo}
          emailSending={emailSending}
          emailSuccess={emailSuccess}
          emailSentAt={invoice.email_sent_at}
          emailSentTo={invoice.email_sent_to}
          onEmailToChange={setEmailTo}
          onSend={() => { void handleSendEmail(); }}
          onClose={() => setShowEmailModal(false)}
        />
        <ConfirmDialog
          open={showCancelConfirm}
          title="Cancel Invoice?"
          message={<>This will cancel <strong>{invoice.invoice_number}</strong>. This action cannot be undone.</>}
          acceptLabel={actionLoading === 'cancel' ? 'Cancelling...' : 'Cancel Invoice'}
          cancelLabel="Keep Invoice"
          tone="destructive"
          loading={actionLoading === 'cancel'}
          onAccept={() => { setShowCancelConfirm(false); void handleAction('cancel'); }}
          onCancel={() => setShowCancelConfirm(false)}
        />
        <RevokePaymentLinkDialog
          open={showRevokeConfirm}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoice_number}
          onClose={() => setShowRevokeConfirm(false)}
          onDone={() => { setError(''); void reloadOpen(); }}
          onError={setError}
        />
      </div>
    </AppLayout>
  );
}
