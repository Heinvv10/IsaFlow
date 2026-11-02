/**
 * What the approver was shown, against what is stored (master plan wave 3, PR S). The HTTP route passes the total,
 * currency and exchange rate the screen showed; approveCustomerInvoice checks them under its row lock, before the
 * approval gate and any write, and a difference throws InvoiceStaleViewError (409 STALE_VIEW): an invoice is never
 * approved at a total, in a currency or at a rate nobody saw. Callers with no screen (MCP, the recurring run) pass none.
 */
import { formatAmount, formatMoney } from '@/lib/money/formatMoney';

export interface ShownInvoice {
  expectedTotal?: number;
  expectedCurrency?: string;
  expectedExchangeRate?: number;
}

interface Stored { total_amount?: unknown; currency_code?: unknown; exchange_rate?: unknown }

const currencyOf = (code: unknown): string => (typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : 'ZAR');
// The column is numeric(…, 6); a stored NULL or 0 converts at 1 (documentCurrency).
const rateOf = (rate: unknown): number => (Number(rate) > 0 ? Number(rate) : 1);
const sameRate = (a: number, b: number): boolean => Math.round(a * 1e6) === Math.round(b * 1e6);

/** "R 1 150.00", or "USD 1 150.00 at 18.5" for a foreign invoice. */
function describe(total: number, currency: string, rate: number): string {
  return currency === 'ZAR' ? formatMoney(total) : `${currency} ${formatAmount(total)} at ${rate}`;
}

export class InvoiceStaleViewError extends Error {
  constructor(shownNow: string) {
    super(`This invoice changed after it was shown: its total is now ${shownNow}. Check it, then approve again.`);
    this.name = 'InvoiceStaleViewError';
  }
}

/** Throws when anything shown differs from the stored row (total to the cent, currency, rate to 6 places). */
export function assertShownIsStored(shown: ShownInvoice, stored: Stored): void {
  const total = Number(stored.total_amount ?? 0);
  const currency = currencyOf(stored.currency_code);
  const rate = rateOf(stored.exchange_rate);
  const stale = (shown.expectedTotal !== undefined && Math.round(total * 100) !== Math.round(shown.expectedTotal * 100))
    || (shown.expectedCurrency !== undefined && currencyOf(shown.expectedCurrency) !== currency)
    || (shown.expectedExchangeRate !== undefined && !sameRate(rateOf(shown.expectedExchangeRate), rate));
  if (stale) throw new InvoiceStaleViewError(describe(total, currency, rate));
}
