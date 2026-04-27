/**
 * AccountLedgerTable
 * Renders the paginated ledger rows plus opening/closing sentinel rows.
 */

import type { AccountLedgerRow } from '@/modules/accounting/services/reports/accountLedgerService';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function fmtDate(d: string): string {
  if (!d) return '—';
  const iso = d.length === 10 ? `${d}T00:00:00` : d;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

interface Props {
  rows: AccountLedgerRow[];
  openingBalance: number;
  /** True period closing balance (server-returned). */
  periodClosingBalance: number;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}

export function AccountLedgerTable({
  rows,
  openingBalance,
  periodClosingBalance,
  page,
  totalPages,
  onPageChange,
}: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)] text-xs uppercase tracking-wide">
            <th className="px-4 py-2 w-28">Date</th>
            <th className="px-4 py-2 w-28">Entry #</th>
            <th className="px-4 py-2">Description</th>
            <th className="px-4 py-2 w-32">Reference</th>
            <th className="px-4 py-2 w-20">Source</th>
            <th className="px-4 py-2 text-right w-28">Debit</th>
            <th className="px-4 py-2 text-right w-28">Credit</th>
            <th className="px-4 py-2 text-right w-32">Balance</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]/40">
            <td colSpan={7} className="px-4 py-2 text-xs text-[var(--ff-text-tertiary)] font-medium">
              Opening Balance
            </td>
            <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">
              {fmt(openingBalance)}
            </td>
          </tr>

          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)] text-sm">
                No transactions in this period
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr
                key={`${r.journalEntryId}-${i}`}
                className="border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-primary)]/50"
              >
                <td className="px-4 py-2 text-[var(--ff-text-tertiary)]">{fmtDate(r.entryDate)}</td>
                <td className="px-4 py-2 font-mono text-[var(--ff-text-secondary)]">{r.entryNumber}</td>
                <td className="px-4 py-2 text-[var(--ff-text-secondary)] max-w-xs truncate">{r.description}</td>
                <td className="px-4 py-2 text-[var(--ff-text-tertiary)] text-xs">{r.reference || '—'}</td>
                <td className="px-4 py-2 text-[var(--ff-text-tertiary)] text-xs">{r.source}</td>
                <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">
                  {r.debit > 0 ? fmt(r.debit) : ''}
                </td>
                <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">
                  {r.credit > 0 ? fmt(r.credit) : ''}
                </td>
                <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-secondary)]">
                  {fmt(r.runningBalance)}
                </td>
              </tr>
            ))
          )}

          <tr className="border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]/40 font-medium">
            <td colSpan={7} className="px-4 py-2 text-xs text-[var(--ff-text-tertiary)]">
              Closing Balance (period)
            </td>
            <td className="px-4 py-2 text-right font-mono text-[var(--ff-text-primary)]">
              {fmt(periodClosingBalance)}
            </td>
          </tr>
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t border-[var(--ff-border-light)]">
          <span className="text-xs text-[var(--ff-text-tertiary)]">
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="p-1.5 rounded border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="p-1.5 rounded border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
