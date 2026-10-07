/**
 * FX PR0: the invoice rows a customer receipt is about to settle, refused
 * (ReceiptRefusal, 400, before any write) if one is in a foreign currency while
 * the company has not enabled them — settlement is currency-blind and would add
 * rands to its foreign amount_paid, which the database refuses anyway
 * (fx_settlement_refusal) with a message no user should see. The AR twin of
 * ap/billAllocatable.billsPayable; `receiptAllocationLines` (every receipt
 * application and bank-line confirm) and `createCustomerPayment` call it.
 */
import { ReceiptRefusal } from './receiptRefusal';
import { assertPostableCurrency, DocumentCurrencyError, loadCompanyCurrency } from '../shared/documentCurrency';

export async function invoicesPayable<T extends { invoice_number?: unknown; currency_code?: unknown }>(
  companyId: string, rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const company = await loadCompanyCurrency(companyId);
  for (const row of rows) {
    try {
      assertPostableCurrency(company, [row.currency_code], 'invoice');
    } catch (err) {
      if (!(err instanceof DocumentCurrencyError)) throw err;
      throw new ReceiptRefusal(`Invoice ${String(row.invoice_number)} cannot take this receipt: ${err.message}`);
    }
  }
  return rows;
}
