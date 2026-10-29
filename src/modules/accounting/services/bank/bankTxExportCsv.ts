/**
 * Bank transactions CSV — one builder for the Bank Transactions page's
 * per-account Export button and the all-accounts export
 * (/api/accounting/bank-transactions-export-all), so both files carry the
 * same columns. Pure: the browser imports it too.
 *
 * Dimensions are what the screen shows (bankTxQueryFragments DIMENSION_JOINS):
 * the bank row's own, else its allocation journal's single set; a journal
 * whose lines disagree is 'split' and has no single value, labelled "Split".
 */
import { csvCell } from '@/lib/csv';

/** The fields the file reads — both the service's BankTransaction and the page's BankTx carry them. */
export interface BankTxExportRow {
  bankAccountName?: string;
  transactionDate: string;
  description?: string;
  reference?: string;
  bankReference?: string;
  amount: number;
  status: string;
  allocatedEntityName?: string;
  cc1Code?: string;
  cc2Code?: string;
  buCode?: string;
  dimensionSource?: 'bank' | 'journal' | 'split';
}

export const BANK_TX_EXPORT_COLUMNS = [
  'Bank Account', 'Date', 'Description', 'Reference', 'Bank Reference',
  'Spent', 'Received', 'Status', 'Allocated To',
  'Cost Centre (CC1)', 'Project (CC2)', 'Business Unit',
] as const;

function dimension(tx: BankTxExportRow, code: string | undefined): string {
  return tx.dimensionSource === 'split' ? 'Split' : code ?? '';
}

/** `bankAccountName` labels rows that carry none (the page's rows are one account's). */
export function bankTxExportCsv(txs: readonly BankTxExportRow[], bankAccountName?: string): string {
  const lines = [BANK_TX_EXPORT_COLUMNS.map(csvCell).join(',')];
  for (const tx of txs) {
    lines.push([
      tx.bankAccountName ?? bankAccountName,
      tx.transactionDate,
      tx.description,
      tx.reference,
      tx.bankReference,
      tx.amount < 0 ? Math.abs(tx.amount).toFixed(2) : '',
      tx.amount > 0 ? tx.amount.toFixed(2) : '',
      tx.status,
      tx.allocatedEntityName,
      dimension(tx, tx.cc1Code),
      dimension(tx, tx.cc2Code),
      dimension(tx, tx.buCode),
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}
