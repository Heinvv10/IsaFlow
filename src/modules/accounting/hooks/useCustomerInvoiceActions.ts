/**
 * useCustomerInvoiceActions — Derives action groups and overflow actions
 * for the customer invoice detail page from invoice state.
 */

import { createElement } from 'react';
import { useRouter } from 'next/router';
import { Mail, Copy, Download, CreditCard, CheckCircle2, Send, FileText, XCircle } from 'lucide-react';
import type { InvoiceActionGroup } from '@/components/invoices/InvoiceActionBar';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import type { CustomerInvoiceDetail } from '@/modules/accounting/types/customerInvoice.types';

interface Options {
  invoiceId: string;
  invoice: CustomerInvoiceDetail;
  actionLoading: string;
  paymentLoading: boolean;
  portalLinkLoading: boolean;
  portalLinkCopied: boolean;
  linkCopied: boolean;
  onOpenEmailModal: () => void;
  onCopyPortalLink: () => void;
  onPayNow: () => void;
  onCopyPaymentLink: () => void;
  onAction: (action: string) => void;
  onShowCancelConfirm: () => void;
}

export function useCustomerInvoiceActions(opts: Options | null): {
  groups: InvoiceActionGroup[];
  overflowActions: ActionMenuItem[];
} {
  const router = useRouter();

  if (!opts) {
    return { groups: [], overflowActions: [] };
  }

  const {
    invoiceId, invoice, actionLoading, paymentLoading,
    portalLinkLoading, portalLinkCopied, linkCopied,
    onOpenEmailModal, onCopyPortalLink, onPayNow,
    onCopyPaymentLink, onAction, onShowCancelConfirm,
  } = opts;

  const balance = Number(invoice.total_amount) - Number(invoice.amount_paid);
  const canApprove = invoice.status === 'draft' || invoice.status === 'pending_approval';
  const canSend = invoice.status === 'approved';
  const canCancel = !['paid', 'cancelled'].includes(invoice.status);
  const canRecordPayment = ['approved', 'sent', 'overdue', 'partially_paid'].includes(invoice.status);
  const recordPaymentClientId = invoice.client_id ?? invoice.customer_id ?? '';
  const canShowPortalLink = !['draft', 'cancelled'].includes(invoice.status);
  const showPaymentButton = invoice.online_payment_enabled && !!invoice.payment_url;
  const showPayNow = !['paid', 'cancelled', 'draft'].includes(invoice.status) && balance > 0;

  const sendGroup: InvoiceActionGroup = {
    label: 'Send',
    actions: [
      {
        label: 'Email Invoice',
        icon: createElement(Mail, { className: 'h-4 w-4' }),
        onClick: onOpenEmailModal,
        variant: 'secondary',
      },
      ...(canShowPortalLink
        ? [{
            label: portalLinkCopied ? 'Link Copied!' : portalLinkLoading ? 'Generating...' : 'Copy Portal Link',
            icon: portalLinkCopied
              ? createElement(CheckCircle2, { className: 'h-4 w-4' })
              : createElement(Copy, { className: 'h-4 w-4' }),
            onClick: onCopyPortalLink,
            disabled: portalLinkLoading,
            variant: 'secondary' as const,
          }]
        : []),
      {
        label: 'Download PDF',
        icon: createElement(Download, { className: 'h-4 w-4' }),
        onClick: () => { window.open(`/api/accounting/invoice-pdf?invoiceId=${invoiceId}`, '_blank', 'noopener,noreferrer'); },
        variant: 'secondary' as const,
      },
    ],
  };

  const collectGroup: InvoiceActionGroup = {
    label: 'Collect',
    actions: [
      ...(showPayNow
        ? [{
            label: paymentLoading ? 'Opening Paystack…' : 'Pay Now',
            icon: createElement(CreditCard, { className: 'h-4 w-4' }),
            onClick: onPayNow,
            disabled: paymentLoading,
            variant: 'primary' as const,
          }]
        : []),
      ...(showPaymentButton
        ? [{
            label: linkCopied ? 'Copied!' : 'Copy Payment Link',
            icon: linkCopied
              ? createElement(CheckCircle2, { className: 'h-4 w-4' })
              : createElement(Copy, { className: 'h-4 w-4' }),
            onClick: onCopyPaymentLink,
            variant: 'secondary' as const,
          }]
        : []),
      ...(canRecordPayment
        ? [{
            label: 'Record Payment',
            icon: createElement(CreditCard, { className: 'h-4 w-4' }),
            onClick: () => {
              void router.push(
                `/accounting/customer-payments/new?invoiceId=${invoiceId}&clientId=${recordPaymentClientId}&amount=${balance.toFixed(2)}`,
              );
            },
            variant: 'primary' as const,
          }]
        : []),
      ...(canApprove
        ? [{
            label: actionLoading === 'approve' ? 'Approving...' : 'Approve',
            icon: createElement(CheckCircle2, { className: 'h-4 w-4' }),
            onClick: () => { onAction('approve'); },
            disabled: !!actionLoading,
            loading: actionLoading === 'approve',
            variant: 'primary' as const,
          }]
        : []),
      ...(canSend
        ? [{
            label: actionLoading === 'send' ? 'Sending...' : 'Mark Sent',
            icon: createElement(Send, { className: 'h-4 w-4' }),
            onClick: () => { onAction('send'); },
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
          icon: createElement(FileText, { className: 'h-4 w-4' }),
          onClick: () => { void router.push(`/accounting/journal-entries/${invoice.gl_journal_entry_id}`); },
          variant: 'secondary' as const,
        }]
      : [],
  };

  const overflowActions: ActionMenuItem[] = [
    ...(canCancel
      ? [{
          label: 'Cancel Invoice',
          icon: createElement(XCircle, { className: 'h-4 w-4' }),
          onClick: onShowCancelConfirm,
          tone: 'destructive' as const,
        }]
      : []),
  ];

  const groups = [sendGroup, collectGroup, accountingGroup].filter(
    g => g.actions.length > 0,
  );

  return { groups, overflowActions };
}
