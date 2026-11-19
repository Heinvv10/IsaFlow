/** The intercompany inbox list: who sent what, its figures, its state, and what a person can do with it (P2). */
import Link from 'next/link';
import { Check, Loader2, RotateCcw, X } from 'lucide-react';
import { StatusPill } from '@/components/ui';
import { formatCurrency, formatDate } from '@/utils/formatters';
import type { InboxItem } from '@/modules/accounting/services/intercompany/inboxTypes';

interface Props {
  items: InboxItem[];
  canWrite: boolean;
  busyId: string | null;
  onReview: (item: InboxItem) => void;
  onReject: (item: InboxItem) => void;
  onDismiss: (item: InboxItem) => void;
  onRestore: (item: InboxItem) => void;
}

const KIND = { invoice: 'Invoice', credit_note: 'Credit note' } as const;

/** Where the accepted draft is. */
const draftHref = (i: InboxItem): string | null => {
  if (!i.targetDocId) return null;
  return i.targetDocType === 'supplier_invoice' ? `/accounting/supplier-invoices/${i.targetDocId}`
    : i.targetDocType === 'credit_note' ? `/accounting/supplier-credit-notes/${i.targetDocId}` : null;
};

const STATUS_LABEL: Record<InboxItem['status'], string> = {
  pending: 'Waiting', failed: 'Needs attention', accepted: 'Accepted', rejected: 'Rejected', dismissed: 'Dismissed',
};

const btn = 'px-2.5 py-1.5 text-xs font-medium rounded-lg border border-line text-ink hover:bg-surface-sunken disabled:opacity-50 inline-flex items-center gap-1.5';

export function InboxTable({ items, canWrite, busyId, onReview, onReject, onDismiss, onRestore }: Props) {
  return (
    <table className="table-cards w-full text-sm" data-testid="inbox-table">
      <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
        <tr>
          {['From', 'Type', 'Number', 'Date', 'Total', 'Status'].map((h, i) => (
            <th key={h} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : 'text-left'}`}>{h}</th>
          ))}
          <th className="px-5 py-3 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {items.map((i) => {
          const open = i.status === 'pending' || i.status === 'failed';
          const href = draftHref(i);
          const busy = busyId === i.id;
          return (
            <tr key={i.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 align-middle" data-testid="inbox-row">
              <td data-label="From" className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{i.senderName}</td>
              <td data-label="Type" className="px-5 py-3.5 text-slate-600 dark:text-slate-300">{KIND[i.kind]}</td>
              <td data-label="Number" className="px-5 py-3.5 tabular-nums text-amber-500 font-semibold">{i.number}</td>
              <td data-label="Date" className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">{formatDate(i.date)}</td>
              <td data-label="Total" className="px-5 py-3.5 text-right tabular-nums font-semibold text-slate-900 dark:text-white">
                {i.total === null ? '—' : formatCurrency(i.kind === 'credit_note' ? -i.total : i.total)}
              </td>
              <td data-label="Status" className="px-5 py-3.5 space-y-1">
                <StatusPill status={i.status === 'failed' ? 'overdue' : i.status === 'pending' ? 'pending' : i.status}>{STATUS_LABEL[i.status]}</StatusPill>
                {i.handledVia === 'auto' && <p className="text-xs text-ink-muted">Accepted automatically</p>}
                {i.status === 'failed' && i.error && <p className="text-xs text-red-600 dark:text-red-400 max-w-xs">{i.error}</p>}
                {i.status === 'rejected' && i.reason && <p className="text-xs text-ink-muted max-w-xs">Reason: {i.reason}</p>}
                {open && i.blocker && <p className="text-xs text-amber-700 dark:text-amber-400 max-w-xs">{i.blocker}</p>}
              </td>
              <td className="px-5 py-3.5 text-right">
                <div className="flex flex-wrap justify-end gap-2">
                  {href && <Link href={href} className={btn}>Open draft</Link>}
                  {open && canWrite && (
                    <>
                      <button type="button" className={btn} disabled={busy} onClick={() => onReview(i)}>
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
                        {i.status === 'failed' ? 'Review and retry' : 'Review'}
                      </button>
                      <button type="button" className={btn} disabled={busy} onClick={() => onReject(i)}><X className="h-3.5 w-3.5" aria-hidden />Reject</button>
                      <button type="button" className={btn} disabled={busy} onClick={() => onDismiss(i)}>Dismiss</button>
                    </>
                  )}
                  {i.status === 'dismissed' && canWrite && (
                    <button type="button" className={btn} disabled={busy} onClick={() => onRestore(i)}><RotateCcw className="h-3.5 w-3.5" aria-hidden />Restore</button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
