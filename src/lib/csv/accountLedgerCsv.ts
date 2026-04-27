/**
 * CSV export helper for the Account Ledger.
 * All string fields are properly quoted and escaped per RFC 4180:
 *   - wrap in double-quotes
 *   - internal double-quotes doubled to ""
 *   - newlines within a field are preserved inside the quotes
 */

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

/**
 * Build a CSV string for the account ledger and trigger a browser download.
 */
export function downloadAccountLedgerCsv(
  meta: AccountLedgerMeta,
  rows: AccountLedgerRow[],
  openingBalance: number,
  periodClosingBalance: number,
): void {
  const headers = [
    'Date', 'Entry #', 'Description', 'Reference', 'Source',
    'Debit', 'Credit', 'Balance',
  ];

  const lines: string[] = [headers.join(',')];

  lines.push(
    [
      '', // Date
      '', // Entry #
      csvField('Opening Balance'),
      '', // Reference
      '', // Source
      '', // Debit
      '', // Credit
      openingBalance.toFixed(2),
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
      csvField('Closing Balance'),
      '', // Reference
      '', // Source
      '', // Debit
      '', // Credit
      periodClosingBalance.toFixed(2),
    ].join(','),
  );

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ledger-${meta.accountCode}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
