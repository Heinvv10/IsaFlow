/**
 * Customer Invoice Detail Page
 * View invoice with line items, approve, send, cancel.
 * Actions grouped by workflow: Send / Collect / Accounting / More.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, ArrowRight, FileText, Loader2, AlertCircle,
  CheckCircle2, Send, XCircle, Download, Mail, X, CreditCard, Copy,
} from 'lucide-react';
import { AccountingDocumentPanel } from '@/modules/accounting/documents';
import { apiFetch } from '@/lib/apiFetch';
import { InvoiceActionBar } from '@/components/invoices/InvoiceActionBar';
import type { InvoiceActionGroup } from '@/components/invoices/InvoiceActionBar';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  pending_approval: 'bg-amber-500/20 text-amber-400',
  approved: 'bg-blue-500/20 text-blue-400',
  sent: 'bg-indigo-500/20 text-indigo-400',
  paid: 'bg-teal-500/20 text-teal-400',
  partially_paid: 'bg-purple-500/20 text-purple-400',
  overdue: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-gray-500/20 text-gray-500',
};

interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  tax_rate: number;
}

interface Invoice {
  id: string;
  invoice_number: string;
  client_name: string;
  project_name: string;
  status: string;
  invoice_date: string;
  due_date: string;
  billing_period_start: string;
  billing_period_end: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  total_amount: number;
  amount_paid: number;
  notes: string;
  gl_journal_entry_id: string;
  client_id?: string;
  customer_id?: string;
  client_email?: string;
  email_sent_at?: string;
  email_sent_to?: string;
  online_payment_enabled?: boolean;
  payment_url?: string;
  items: InvoiceItem[];
}

export default function CustomerInvoiceDetailPage() {
  const router = useRouter();
  const { invoiceId } = router.query;
  const [invoice, setInvoice] = useState<Invoice | null>(null);
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
      // non-critical — navigation simply stays disabled
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

  const handleAction = async (action: string) => {
    setActionLoading(action);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-detail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, action }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error?.message || 'Failed');
      }
      await loadInvoice();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading('');
    }
  };

  const handleOpenEmailModal = () => {
    setEmailTo(invoice?.client_email || invoice?.email_sent_to || '');
    setEmailSuccess('');
    setShowEmailModal(true);
  };

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
      if (json.data?.sent) {
        setEmailSuccess('Invoice emailed successfully!');
        await loadInvoice();
      } else {
        setEmailSuccess(json.message || 'Email could not be sent. Check SMTP configuration.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send email');
    } finally {
      setEmailSending(false);
    }
  };

  const handleEnablePayment = async () => {
    setPaymentLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/payment-gateway', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId, action: 'enable' }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error?.message || e.message || 'Failed');
      }
      await loadInvoice();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable online payment');
    } finally {
      setPaymentLoading(false);
    }
  };

  const handleCopyPaymentLink = async () => {
    if (!invoice?.payment_url) return;
    try {
      await navigator.clipboard.writeText(invoice.payment_url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      setError('Failed to copy link');
    }
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
    } finally {
      setPortalLinkLoading(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
        </div>
      </AppLayout>
    );
  }

  if (!invoice) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center min-h-[60vh] flex-col">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-[var(--ff-text-secondary)]">{error || 'Invoice not found'}</p>
        </div>
      </AppLayout>
    );
  }

  const balance = Number(invoice.total_amount) - Number(invoice.amount_paid);
  const canApprove = invoice.status === 'draft' || invoice.status === 'pending_approval';
  const canSend = invoice.status === 'approved';
  const canCancel = !['paid', 'cancelled'].includes(invoice.status);
  const canRecordPayment = ['approved', 'sent', 'overdue', 'partially_paid'].includes(invoice.status);
  const recordPaymentClientId = invoice.client_id ?? invoice.customer_id ?? '';
  const canShowPortalLink = !['draft', 'cancelled'].includes(invoice.status);
  const showPaymentButton = invoice.online_payment_enabled && !!invoice.payment_url;
  const showEnablePayment = !invoice.online_payment_enabled && !['paid', 'cancelled', 'draft'].includes(invoice.status);

  // ── Action groups ────────────────────────────────────────────────────────────

  const sendGroup: InvoiceActionGroup = {
    label: 'Send',
    actions: [
      {
        label: 'Email Invoice',
        icon: <Mail className="h-4 w-4" />,
        onClick: handleOpenEmailModal,
        variant: 'secondary',
      },
      ...(canShowPortalLink
        ? [{
            label: portalLinkCopied ? 'Link Copied!' : portalLinkLoading ? 'Generating...' : 'Copy Portal Link',
            icon: portalLinkCopied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />,
            onClick: () => { void handleCopyPortalLink(); },
            disabled: portalLinkLoading,
            variant: 'secondary' as const,
          }]
        : []),
      {
        label: 'Download PDF',
        icon: <Download className="h-4 w-4" />,
        onClick: () => { window.open(`/api/accounting/invoice-pdf?invoiceId=${String(invoiceId)}`, '_blank'); },
        variant: 'secondary' as const,
      },
    ],
  };

  const collectGroup: InvoiceActionGroup = {
    label: 'Collect',
    actions: [
      ...(showEnablePayment
        ? [{
            label: paymentLoading ? 'Enabling...' : 'Enable Online Payment',
            icon: <CreditCard className="h-4 w-4" />,
            onClick: () => { void handleEnablePayment(); },
            disabled: paymentLoading,
            variant: 'secondary' as const,
          }]
        : []),
      ...(showPaymentButton
        ? [{
            label: linkCopied ? 'Copied!' : 'Copy Payment Link',
            icon: linkCopied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />,
            onClick: () => { void handleCopyPaymentLink(); },
            variant: 'secondary' as const,
          }]
        : []),
      ...(canRecordPayment
        ? [{
            label: 'Record Payment',
            icon: <CreditCard className="h-4 w-4" />,
            onClick: () => {
              void router.push(
                `/accounting/customer-payments/new?invoiceId=${String(invoiceId)}&clientId=${recordPaymentClientId}&amount=${balance.toFixed(2)}`,
              );
            },
            variant: 'primary' as const,
          }]
        : []),
      ...(canApprove
        ? [{
            label: actionLoading === 'approve' ? 'Approving...' : 'Approve',
            icon: <CheckCircle2 className="h-4 w-4" />,
            onClick: () => { void handleAction('approve'); },
            disabled: !!actionLoading,
            loading: actionLoading === 'approve',
            variant: 'primary' as const,
          }]
        : []),
      ...(canSend
        ? [{
            label: actionLoading === 'send' ? 'Sending...' : 'Mark Sent',
            icon: <Send className="h-4 w-4" />,
            onClick: () => { void handleAction('send'); },
            disabled: !!actionLoading,
            loading: actionLoading === 'send',
            variant: 'primary' as const,
          }]
        : []),
    ],
  };

  const accountingGroup: InvoiceActionGroup = {
    label: 'Accounting',
    actions: invoice.gl_journal_entry_id
      ? [{
          label: 'View GL Entry',
          icon: <FileText className="h-4 w-4" />,
          onClick: () => { void router.push(`/accounting/journal-entries/${invoice.gl_journal_entry_id}`); },
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

  const activeGroups = [sendGroup, collectGroup, accountingGroup].filter(
    g => g.actions.length > 0,
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <Link
              href="/accounting/customer-invoices"
              className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-blue-400"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Invoices
            </Link>
            <div className="flex items-center gap-1">
              <button
                onClick={() => prevId && void router.push(`/accounting/customer-invoices/${prevId}`)}
                disabled={!prevId}
                title="Previous invoice"
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <button
                onClick={() => nextId && void router.push(`/accounting/customer-invoices/${nextId}`)}
                disabled={!nextId}
                title="Next invoice"
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                Next <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex items-end justify-between gap-4 flex-wrap">
            {/* Title block */}
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <FileText className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">{invoice.invoice_number}</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {invoice.client_name} — {invoice.project_name}
                </p>
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${STATUS_COLORS[invoice.status] || ''}`}>
                {invoice.status.replace(/_/g, ' ')}
              </span>
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

        {portalUrl && (
          <div className="mx-6 mt-3 flex items-center gap-2">
            <span className="text-xs text-[var(--ff-text-secondary)] shrink-0">Portal link:</span>
            <input
              readOnly
              value={portalUrl}
              className="flex-1 text-xs bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded px-2 py-1 text-teal-400 font-mono truncate"
            />
          </div>
        )}

        <div className="p-6 space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Invoice Date', value: invoice.invoice_date?.split('T')[0] },
              { label: 'Due Date', value: invoice.due_date?.split('T')[0] || '—' },
              {
                label: 'Billing Period',
                value:
                  invoice.billing_period_start && invoice.billing_period_end
                    ? `${String(invoice.billing_period_start).split('T')[0]} → ${String(invoice.billing_period_end).split('T')[0]}`
                    : '—',
              },
              { label: 'VAT Rate', value: `${invoice.tax_rate}%` },
              { label: 'Subtotal', value: fmt(Number(invoice.subtotal)) },
              { label: 'VAT', value: fmt(Number(invoice.tax_amount)) },
              { label: 'Total', value: fmt(Number(invoice.total_amount)), hl: true },
              { label: 'Balance Due', value: fmt(balance), hl: balance > 0 },
            ].map((c, i) => (
              <div key={i} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">{c.label}</p>
                <p className={`text-lg font-semibold mt-1 ${c.hl ? 'text-blue-400' : 'text-[var(--ff-text-primary)]'}`}>
                  {c.value}
                </p>
              </div>
            ))}
          </div>

          {/* Line items */}
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
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Tax Rate</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-light)]">
                {(invoice.items || []).map(item => (
                  <tr key={item.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                    <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">{item.description || '—'}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{item.quantity}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono">{fmt(Number(item.unit_price))}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-secondary)]">{Number(item.tax_rate)}{'%'}</td>
                    <td className="px-4 py-3 text-sm text-right font-mono font-medium">{fmt(Number(item.amount))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)]">
                  <td colSpan={3}></td>
                  <td className="px-4 py-3 text-sm text-right font-medium text-[var(--ff-text-secondary)]">Total:</td>
                  <td className="px-4 py-3 text-sm text-right font-mono font-bold text-blue-400">{fmt(Number(invoice.total_amount))}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {invoice.notes && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase mb-1">Notes</p>
              <p className="text-sm text-[var(--ff-text-secondary)]">{invoice.notes}</p>
            </div>
          )}

          {/* Documents */}
          <AccountingDocumentPanel
            entityType="customer_invoice"
            entityId={invoiceId as string}
            allowedTypes={[
              { value: 'invoice', label: 'Invoice PDF' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </div>

        {/* Email Invoice Modal */}
        {showEmailModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={() => setShowEmailModal(false)}
          >
            <div
              className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] shadow-2xl w-full max-w-md mx-4 p-6"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Email Invoice</h3>
                <button
                  onClick={() => setShowEmailModal(false)}
                  className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="text-sm text-[var(--ff-text-secondary)] mb-4">
                Send invoice <strong>{invoice.invoice_number}</strong> as a PDF attachment.
              </p>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">
                Recipient Email
              </label>
              <input
                type="email"
                value={emailTo}
                onChange={e => setEmailTo(e.target.value)}
                placeholder="client@example.com"
                className="w-full px-3 py-2 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/50 mb-4"
              />
              {emailSuccess && (
                <div
                  className={`flex items-center gap-2 p-3 rounded-lg text-sm mb-4 ${
                    emailSuccess.includes('successfully')
                      ? 'bg-teal-500/10 text-teal-400'
                      : 'bg-amber-500/10 text-amber-400'
                  }`}
                >
                  {emailSuccess.includes('successfully')
                    ? <CheckCircle2 className="h-4 w-4" />
                    : <AlertCircle className="h-4 w-4" />}
                  {emailSuccess}
                </div>
              )}
              {invoice.email_sent_at && (
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-4">
                  Last sent to {invoice.email_sent_to} on {invoice.email_sent_at.split('T')[0]}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowEmailModal(false)}
                  className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] rounded-lg border border-[var(--ff-border-light)]"
                >
                  Close
                </button>
                <button
                  onClick={() => { void handleSendEmail(); }}
                  disabled={emailSending || !emailTo.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-teal-600 text-white rounded-lg text-sm hover:bg-teal-500 disabled:opacity-50"
                >
                  {emailSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {emailSending ? 'Sending...' : 'Send Email'}
                </button>
              </div>
            </div>
          </div>
        )}

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
                This will cancel <strong>{invoice.invoice_number}</strong>. This action cannot be undone.
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
