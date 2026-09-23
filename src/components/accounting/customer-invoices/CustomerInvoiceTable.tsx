/**
 * Customer invoice list table with pagination — extracted from the list page
 * (pages/accounting/customer-invoices/index.tsx) to keep it under 300 lines.
 */

import Link from 'next/link';
import { Eye } from 'lucide-react';
import { StatusPill } from '@/components/ui';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { toBucketKey, relativeTimeSince } from '@/components/invoices/ARFilters';
import { BUCKET_COLORS, BUCKET_LABELS } from '@/lib/format/aging';

export interface CustomerInvoiceRow {
  id: string;
  invoice_number: string;
  project_id: string;
  project_name?: string;
  client_name?: string;
  total_amount: number;
  amount_paid: number;
  status: string;
  reference?: string;
  invoice_date: string;
  due_date?: string;
  last_viewed_at?: string | null;
  view_count?: number;
  days_overdue?: number | null;
  aging_bucket?: string | null;
}

interface Props {
  invoices: CustomerInvoiceRow[];
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
}

export function CustomerInvoiceTable({ invoices, page, limit, total, onPage }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)]">
            <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Invoice #</th>
            <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Client</th>
            <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Reference</th>
            <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Date</th>
            <th className="text-right py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Amount</th>
            <th className="text-right py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Outstanding</th>
            <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Aging</th>
            <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Last Viewed</th>
            <th className="text-left py-3 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const outstanding = Number(inv.total_amount) - Number(inv.amount_paid);
            const bucketKey = toBucketKey(inv.aging_bucket);
            const bucketLabel = inv.aging_bucket === 'Current' ? 'Current' : (bucketKey ? BUCKET_LABELS[bucketKey] : null);
            const bucketColor = bucketKey ? BUCKET_COLORS[bucketKey] : 'text-teal-500';
            return (
              <tr key={inv.id} className="border-b border-[var(--ff-border-light)] hover:bg-teal-500/[0.04]">
                <td className="py-3 px-4 font-mono">
                  <Link href={`/accounting/customer-invoices/${inv.id}`} className="text-blue-400 hover:text-blue-300">{inv.invoice_number}</Link>
                </td>
                <td className="py-3 px-4 text-[var(--ff-text-primary)]">{inv.client_name || '-'}</td>
                <td className="py-3 px-4 text-[var(--ff-text-tertiary)] max-w-[200px] truncate" title={inv.reference}>
                  {inv.reference || inv.project_name || '-'}
                </td>
                <td className="py-3 px-4 text-[var(--ff-text-secondary)] whitespace-nowrap">{formatDate(inv.invoice_date)}</td>
                <td className="py-3 px-4 text-right font-mono tabular-nums text-[var(--ff-text-primary)]">{formatCurrency(Number(inv.total_amount))}</td>
                <td className={`py-3 px-4 text-right font-mono tabular-nums ${outstanding > 0 ? 'text-amber-400' : 'text-teal-400'}`}>
                  {formatCurrency(outstanding)}
                </td>
                <td className="py-3 px-4 whitespace-nowrap">
                  {inv.status === 'paid' ? (
                    <span className="text-xs text-[var(--ff-text-tertiary)]">Paid</span>
                  ) : bucketLabel ? (
                    <span className={`text-xs font-medium ${bucketColor}`}>{bucketLabel}</span>
                  ) : (
                    <span className="text-xs text-[var(--ff-text-tertiary)]">—</span>
                  )}
                </td>
                <td className="py-3 px-4 whitespace-nowrap">
                  {inv.last_viewed_at ? (
                    <span
                      className="inline-flex items-center gap-1.5 text-xs text-[var(--ff-text-secondary)]"
                      title={`${inv.view_count ?? 0} view${inv.view_count === 1 ? '' : 's'} · ${new Date(inv.last_viewed_at).toLocaleString('en-ZA')}`}
                    >
                      <Eye className="h-3.5 w-3.5 text-teal-400" />
                      {relativeTimeSince(inv.last_viewed_at)}
                    </span>
                  ) : (
                    <span className="text-xs text-[var(--ff-text-tertiary)]">—</span>
                  )}
                </td>
                <td className="py-3 px-4">
                  <StatusPill status={inv.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--ff-border-light)]">
          <span className="text-sm text-[var(--ff-text-secondary)]">
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button onClick={() => onPage(page - 1)} disabled={page === 1} className="px-3 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-secondary)] disabled:opacity-40 rounded-lg text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]">
              Previous
            </button>
            <button onClick={() => onPage(page + 1)} disabled={page * limit >= total} className="px-3 py-1.5 text-sm bg-[var(--ff-bg-tertiary)] hover:bg-[var(--ff-bg-secondary)] disabled:opacity-40 rounded-lg text-[var(--ff-text-primary)] border border-[var(--ff-border-light)]">
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
