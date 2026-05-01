/**
 * Customer Invoice Detail Page
 * View invoice with line items, approve, send, cancel.
 * Actions grouped by workflow: Send / Collect / Accounting / More.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, FileText, Loader2, AlertCircle, Pencil } from 'lucide-react';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import { apiFetch } from '@/lib/apiFetch';
import { InvoiceActionBar } from '@/components/invoices/InvoiceActionBar';
import { InvoiceEmailModal } from '@/components/invoices/InvoiceEmailModal';
import { CustomerInvoiceSummary } from '@/components/invoices/CustomerInvoiceSummary';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useCustomerInvoiceActions } from '@/modules/accounting/hooks/useCustomerInvoiceActions';
import type { CustomerInvoiceDetail } from '@/modules/accounting/types/customerInvoice.types';
import { CUSTOMER_INVOICE_STATUS_COLORS } from '@/modules/accounting/types/customerInvoice.types';

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
  const [prevId, setPrevId] = useState<string | null>(null);
  const [nextId, setNextId] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const loadAdjacent = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/accounting/customer-invoices-adjacent?id=${id}`);
      const json = await res.json() as { data: { prevId: string | null; nextId: string | null } };
      setPrevId(json.data?.prevId ?? null);
      setNextId(json.data?.nextId ?? null);
    } catch {
      // non-critical — navigation stays disabled
    }
  }, []);

  const loadInvoice = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/accounting/customer-invoices-detail?id=${invoiceId}`);
      const json = await res.json();
      setInvoice(json.data || json);
    } catch {
      setError('Failed to load invoice');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

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
      if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || 'Failed'); }
      await loadInvoice();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
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
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to send');
      setEmailSuccess(json.data?.sent ? 'Invoice emailed successfully!' : (json.message || 'Email could not be sent.'));
      if (json.data?.sent) await loadInvoice();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send email');
    } finally { setEmailSending(false); }
  };

  const handlePayNow = async () => {
    setPaymentLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/customer-invoices/${invoiceId}/pay-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json.data?.checkoutUrl) {
        throw new Error(json.error?.message || json.message || 'Failed to start payment');
      }
      window.open(json.data.checkoutUrl as string, '_blank', 'noopener,noreferrer');
      await loadInvoice();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start payment');
    } finally { setPaymentLoading(false); }
  };

  const handleCopyPaymentLink = async () => {
    if (!invoice?.payment_url) return;
    try {
      await navigator.clipboard.writeText(invoice.payment_url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch { setError('Failed to copy link'); }
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
      const json = await res.json() as { success: boolean; data?: { portalUrl: string } };
      if (!res.ok || !json.data?.portalUrl) throw new Error('Failed to generate portal link');
      setPortalUrl(json.data.portalUrl);
      await navigator.clipboard.writeText(json.data.portalUrl);
      setPortalLinkCopied(true);
      setTimeout(() => setPortalLinkCopied(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate portal link');
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
    } : null,
  );

  if (loading) return <AppLayout><div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="h-8 w-8 animate-spin text-blue-500" /></div></AppLayout>;
  if (!invoice) return <AppLayout><div className="flex items-center justify-center min-h-[60vh] flex-col"><AlertCircle className="h-8 w-8 text-red-400 mb-2" /><p className="text-[var(--ff-text-secondary)]">{error || 'Invoice not found'}</p></div></AppLayout>;

  const balance = Number(invoice.total_amount) - Number(invoice.amount_paid);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <Link href="/accounting/customer-invoices" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400">
              <ArrowLeft className="h-4 w-4" /> Back to Invoices
            </Link>
            <div className="flex items-center gap-1">
              <button onClick={() => prevId && void router.push(`/accounting/customer-invoices/${prevId}`)} disabled={!prevId} title="Previous invoice" className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                <ArrowLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <button onClick={() => nextId && void router.push(`/accounting/customer-invoices/${nextId}`)} disabled={!nextId} title="Next invoice" className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                Next <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><FileText className="h-6 w-6 text-blue-500" /></div>
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
      </div>
    </AppLayout>
  );
}
