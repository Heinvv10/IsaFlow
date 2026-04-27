/**
 * useSupplierInvoiceActions — Derives action groups and overflow actions
 * for the supplier invoice detail page from invoice state.
 */

import { createElement } from 'react';
import { useRouter } from 'next/router';
import { Download, Pencil, Save, Link2, CheckCircle2, CreditCard, FileText, XCircle } from 'lucide-react';
import type { InvoiceActionGroup } from '@/components/invoices/InvoiceActionBar';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import type { SupplierInvoice, SupplierInvoiceItem } from '@/modules/accounting/types/ap.types';

type InvoiceWithItems = SupplierInvoice & { items: SupplierInvoiceItem[] };

interface Options {
  invoiceId: string;
  invoice: InvoiceWithItems;
  actionLoading: string;
  editing: boolean;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onAction: (action: string) => void;
  onShowCancelConfirm: () => void;
}

export function useSupplierInvoiceActions(opts: Options | null): {
  groups: InvoiceActionGroup[];
  overflowActions: ActionMenuItem[];
} {
  const router = useRouter();

  if (!opts) {
    return { groups: [], overflowActions: [] };
  }

  const {
    invoiceId, invoice, actionLoading, editing,
    onStartEdit, onSaveEdit, onAction, onShowCancelConfirm,
  } = opts;

  const canEdit = invoice.status === 'draft' || invoice.status === 'pending_approval';
  const canApprove = canEdit;
  const canCancel = invoice.status !== 'paid' && invoice.status !== 'partially_paid' && invoice.status !== 'cancelled';
  const canMatch = !!invoice.purchaseOrderId;
  const canRecordPayment = ['approved', 'partially_paid'].includes(invoice.status) && invoice.balance > 0;

  const documentsGroup: InvoiceActionGroup = {
    label: 'Documents',
    actions: [
      {
        label: 'Download PDF',
        icon: createElement(Download, { className: 'h-4 w-4' }),
        onClick: () => {
          window.open(
            `/api/accounting/supplier-invoice-pdf?invoiceId=${invoiceId}`,
            '_blank',
            'noopener,noreferrer',
          );
        },
        variant: 'secondary',
      },
      ...(canEdit && !editing
        ? [{
            label: 'Edit',
            icon: createElement(Pencil, { className: 'h-4 w-4' }),
            onClick: onStartEdit,
            variant: 'secondary' as const,
          }]
        : []),
      ...(editing
        ? [{
            label: actionLoading === 'save' ? 'Saving...' : 'Save',
            icon: createElement(Save, { className: 'h-4 w-4' }),
            onClick: onSaveEdit,
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
            icon: createElement(Link2, { className: 'h-4 w-4' }),
            onClick: () => { onAction('match'); },
            disabled: !!actionLoading,
            loading: actionLoading === 'match',
            variant: 'secondary' as const,
          }]
        : []),
      ...(canApprove
        ? [{
            label: actionLoading === 'approve' ? 'Approving...' : 'Approve & Post GL',
            icon: createElement(CheckCircle2, { className: 'h-4 w-4' }),
            onClick: () => { onAction('approve'); },
            disabled: !!actionLoading,
            loading: actionLoading === 'approve',
            variant: 'primary' as const,
          }]
        : []),
      ...(canRecordPayment
        ? [{
            label: 'Record Payment',
            icon: createElement(CreditCard, { className: 'h-4 w-4' }),
            onClick: () => {
              void router.push(
                `/accounting/supplier-payments/new?invoiceId=${invoiceId}&supplierId=${invoice.supplierId}&amount=${invoice.balance.toFixed(2)}`,
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
          icon: createElement(FileText, { className: 'h-4 w-4' }),
          onClick: () => { void router.push(`/accounting/journal-entries/${invoice.glJournalEntryId}`); },
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

  const groups = [documentsGroup, payGroup, accountingGroup].filter(
    g => g.actions.length > 0,
  );

  return { groups, overflowActions };
}
