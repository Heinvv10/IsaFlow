/**
 * CSV export helper for the Account Ledger.
 * All string fields are properly quoted and escaped per RFC 4180:
 *   - wrap in double-quotes
 *   - internal double-quotes doubled to ""
 *   - newlines within a field are preserved inside the quotes
 */

import { toMoney } from '@/lib/money/decimalSum';
import type {
  AccountLedgerMeta,
  AccountLedgerRow,
} from '@/modules/accounting/services/reports/accountLedgerService';

/**
 * Wrap a string value in CSV double-quotes, escaping internal quotes.
 * Numbers and booleans are returned as-is (no quotes needed).
 */
export function csvField(value: string): string {
  // Escape internal double-quotes by doubling them
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

export interface LedgerCsvPage {
  page: number;
  totalPages: number;
}

/**
 * The CSV text for one page of the account ledger. Page 1 opens at the ledger's
 * opening balance; a later page opens at the balance its first row started from
 * (derived year-end close rows included), so each page's opening is the previous
 * page's closing. Only the last page closes at the period closing balance.
 */
export function buildAccountLedgerCsv(
  meta: AccountLedgerMeta,
  rows: AccountLedgerRow[],
  openingBalance: number,
  periodClosingBalance: number,
  { page, totalPages }: LedgerCsvPage = { page: 1, totalPages: 1 },
): string {
  const headers = [
    'Date', 'Entry #', 'Description', 'Reference', 'Source',
    'Debit', 'Credit', 'Balance',
  ];

  const first = rows[0];
  const last = rows[rows.length - 1];
  const fromPrevious = page > 1 && first !== undefined;
  const pageOpening = fromPrevious
    ? toMoney(first.runningBalance - (meta.normalBalance === 'debit' ? first.debit - first.credit : first.credit - first.debit))
    : openingBalance;
  const carriesForward = page < totalPages && last !== undefined;
  const pageClosing = carriesForward ? last.runningBalance : periodClosingBalance;

  const lines: string[] = [headers.join(',')];

  lines.push(
    [
      '', // Date
      '', // Entry #
      csvField(fromPrevious ? 'Balance Brought Forward' : 'Opening Balance'),
      '', // Reference
      '', // Source
      '', // Debit
      '', // Credit
      pageOpening.toFixed(2),
    ].join(','),
  );

  for (const r of rows) {
    lines.push(
      [
        r.entryDate,
        csvField(r.entryNumber),
        csvField(r.description),
        csvField(r.reference),
        csvField(r.source),
        r.debit > 0 ? r.debit.toFixed(2) : '',
        r.credit > 0 ? r.credit.toFixed(2) : '',
        r.runningBalance.toFixed(2),
      ].join(','),
    );
  }

  lines.push(
    [
      '', // Date
      '', // Entry #
      csvField(carriesForward ? 'Balance Carried Forward' : 'Closing Balance'),
      '', // Reference
      '', // Source
      '', // Debit
      '', // Credit
      pageClosing.toFixed(2),
    ].join(','),
  );

  return lines.join('\n');
}

/**
 * Build a CSV string for the account ledger page and trigger a browser download.
 */
export function downloadAccountLedgerCsv(
  meta: AccountLedgerMeta,
  rows: AccountLedgerRow[],
  openingBalance: number,
  periodClosingBalance: number,
  pageInfo?: LedgerCsvPage,
): void {
  const csv = buildAccountLedgerCsv(meta, rows, openingBalance, periodClosingBalance, pageInfo);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-${meta.accountCode}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
