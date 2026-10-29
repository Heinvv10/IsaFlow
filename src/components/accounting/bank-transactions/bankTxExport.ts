/**
 * Bank Transactions page CSV downloads. Both files share one column set
 * (services/bank/bankTxExportCsv): the loaded rows of the selected account,
 * or every bank account's posted lines in a date range, built server-side.
 */

import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { bankTxExportCsv } from '@/modules/accounting/services/bank/bankTxExportCsv';
import type { BankTx } from '@/components/accounting/BankTxTable';

function downloadCsv(csv: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  // Revoking in the same tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportLoadedBankTx(transactions: BankTx[], bankAccountCode?: string, bankAccountName?: string): void {
  downloadCsv(bankTxExportCsv(transactions, bankAccountName), `bank-transactions-${bankAccountCode || 'export'}.csv`);
}

export async function exportAllBankTx(fromDate: string, toDate: string): Promise<void> {
  if (!fromDate || !toDate) {
    notify.error('Set the From and To dates first, then export all accounts');
    return;
  }
  try {
    const res = await apiFetch(
      `/api/accounting/bank-transactions-export-all?from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`);
    await assertOk(res, 'Could not export the bank transactions - try again');
    downloadCsv(await res.text(), `bank-transactions-all-${fromDate}-to-${toDate}.csv`);
  } catch (e) {
    notify.error(apiErrorMessage(e, 'Could not export the bank transactions - try again'));
  }
}
