/**
 * AccountLedgerTable
 * Renders the paginated ledger rows plus opening/closing sentinel rows.
 */

import type { AccountLedgerRow } from '@/modules/accounting/services/reports/accountLedgerService';
import { ledgerPageBoundaries } from '@/lib/csv/ledgerPageBoundaries';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatSaDateValue } from '@/lib/saDateParser';

const fmt = (n: number) => formatMoney(n);

function fmtDate(d: string): string {
  if (!d) return '—';
  const iso = d.length === 10 ? `${d}T00:00:00` : d;
  const date = new Date(iso);
  if (isNaN(date.getTime())) return d;
  return formatSaDateValue(date);
}

interface Props {
  rows: AccountLedgerRow[];
  openingBalance: number;
  /** True period closing balance (server-returned). */
  periodClosingBalance: number;
  normalBalance: string;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}

export function AccountLedgerTable({
  rows,
  openingBalance,
  periodClosingBalance,
  normalBalance,
  page,
  totalPages,
  onPageChange,
}: Props) {
  const b = ledgerPageBoundaries(normalBalance, rows, openingBalance, periodClosingBalance, page, totalPages);
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
              {b.openingLabel}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-[var(--ff-text-secondary)]">
              {fmt(b.opening)}
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
                className={`border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-primary)]/50${r.derived ? ' italic' : ''}`}
              >
                <td className="px-4 py-2 text-[var(--ff-text-tertiary)]">{fmtDate(r.entryDate)}</td>
                <td className="px-4 py-2 font-mono text-[var(--ff-text-secondary)]">{r.entryNumber}</td>
                <td className="px-4 py-2 text-[var(--ff-text-secondary)] max-w-xs truncate">{r.description}</td>
                <td className="px-4 py-2 text-[var(--ff-text-tertiary)] text-xs">{r.reference || '—'}</td>
                <td className="px-4 py-2 text-[var(--ff-text-tertiary)] text-xs">{r.source}</td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--ff-text-primary)]">
                  {r.debit > 0 ? fmt(r.debit) : ''}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--ff-text-primary)]">
                  {r.credit > 0 ? fmt(r.credit) : ''}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[var(--ff-text-secondary)]">
                  {fmt(r.runningBalance)}
                </td>
              </tr>
            ))
          )}

          <tr className="border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]/40 font-medium">
            <td colSpan={7} className="px-4 py-2 text-xs text-[var(--ff-text-tertiary)]">
              {b.closingLabel}
            </td>
            <td className="px-4 py-2 text-right tabular-nums text-[var(--ff-text-primary)]">
              {fmt(b.closing)}
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
