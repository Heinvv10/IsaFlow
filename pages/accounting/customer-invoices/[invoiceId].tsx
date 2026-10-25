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
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { startPayNowCheckout } from '@/modules/accounting/utils/payNowCheckout';
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
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [portalUrl, setPortalUrl] = useState('');
  const [portalLinkLoading, setPortalLinkLoading] = useState(false);
  const [portalLinkCopied, setPortalLinkCopied] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const { prevId, nextId, loadAdjacent, clear: clearAdjacent } = useAdjacentInvoices();

  const loadInvoice = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/customer-invoices-detail?id=${invoiceId}`);
      await assertOk(res, 'Could not load the invoice - try again');
      const json = await res.json();
      setInvoice(json.data || json);
    } catch (err) {
      setInvoice(null); clearAdjacent();
      setError(apiErrorMessage(err, 'Could not load the invoice - try again'));
    } finally {
      setLoading(false);
    }
  }, [invoiceId, clearAdjacent]);

  useEffect(() => {
    if (!invoiceId) return;
    void loadInvoice();
    void loadAdjacent(invoiceId as string);
  }, [invoiceId, loadInvoice, loadAdjacent]);

  const handleAction = useCallback(async (action: string) => {
    setActionLoading(action);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, action }),
      });
      // R-035: 409 is the approval gate — reload so the page offers Submit for approval.
      if (res.status === 409) await loadInvoice();
      await assertOk(res, 'Could not complete that action - try again');
      await loadInvoice();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not complete that action - try again'));
    } finally {
      setActionLoading('');
    }
  }, [invoiceId, loadInvoice]);

  const handleSendEmail = async () => {
    if (!emailTo.trim()) return;
    setEmailSending(true);
    setEmailSuccess('');
    try {
      const res = await apiFetch('/api/accounting/invoice-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId, recipientEmail: emailTo.trim() }),
      });
      await assertOk(res, 'Could not send the invoice email - try again');
      const json = await res.json();
      setEmailSuccess(json.data?.sent ? 'Invoice emailed successfully!' : (json.message || 'Email could not be sent.'));
      if (json.data?.sent) await loadInvoice();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not send the invoice email - try again'));
    } finally { setEmailSending(false); }
  };

  const handlePayNow = async () => {
    setPaymentLoading(true);
    setError('');
    try {
      window.open(await startPayNowCheckout(invoiceId as string), '_blank', 'noopener,noreferrer');
      await loadInvoice();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not start the payment - try again'));
    } finally { setPaymentLoading(false); }
  };

  const handleCopyPaymentLink = async () => {
    if (!invoice?.payment_url) return;
    try {
      await navigator.clipboard.writeText(invoice.payment_url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { setError('Could not copy the link - copy it manually'); }
  };

  const handleCopyPortalLink = async () => {
    if (!invoiceId) return;
    setPortalLinkLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/portal/invoice/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId }),
      });
      await assertOk(res, 'Could not generate the portal link - try again');
      const json = await res.json() as { success: boolean; data?: { portalUrl: string } };
      if (!json.data?.portalUrl) throw new Error('Could not generate the portal link - try again');
      setPortalUrl(json.data.portalUrl);
      await navigator.clipboard.writeText(json.data.portalUrl);
      setPortalLinkCopied(true);
      setTimeout(() => setPortalLinkCopied(false), 3000);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not generate the portal link - try again'));
    } finally { setPortalLinkLoading(false); }
  };

  const { groups, overflowActions } = useCustomerInvoiceActions(
    invoice ? {
      invoiceId: invoiceId as string, invoice, actionLoading, paymentLoading,
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
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${CUSTOMER_INVOICE_STATUS_COLORS[invoice.status] || ''}`}>{invoice.status.replace(/_/g, ' ')}</span>
              {invoice.status === 'draft' && (
                <Link
                  href={`/accounting/customer-invoices/edit/${String(invoiceId)}`}
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
          approval={invoice.approval} onChanged={loadInvoice} />
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
          />
          {/* GL Journal link — body anchor for discoverability, matching supplier page */}
          {invoice.gl_journal_entry_id && (
            <Link href={`/accounting/journal-entries/${invoice.gl_journal_entry_id}`} className="inline-flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300">
              <FileText className="h-4 w-4" /> View GL Journal Entry
            </Link>
          )}
          <MarkVatDeclaredElsewhereButton
            kind="customer" invoiceId={invoiceId as string}
            glJournalEntryId={invoice.gl_journal_entry_id || null} taxAmount={invoice.tax_amount}
            onMarked={() => void loadInvoice()}
          />
          <AccountingDocumentPanel
            entityType="customer_invoice"
            entityId={invoiceId as string}
            allowedTypes={[
              { value: 'invoice', label: 'Invoice PDF' },
              { value: 'other', label: 'Other' },
            ]}
          />
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
          invoiceId={invoiceId as string}
          invoiceNumber={invoice.invoice_number}
          onClose={() => setShowRevokeConfirm(false)}
          onDone={() => { setError(''); void loadInvoice(); }}
          onError={setError}
        />
      </div>
    </AppLayout>
  );
}
