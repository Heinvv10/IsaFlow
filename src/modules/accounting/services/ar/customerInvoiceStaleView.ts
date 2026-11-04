/**
 * What the approver was shown, against what is stored (master plan wave 3, PR S). The HTTP route passes the total,
 * currency and exchange rate the screen showed; approveCustomerInvoice checks them under its row lock, before the
 * approval gate and any write, and a difference throws InvoiceStaleViewError (409 STALE_VIEW): an invoice is never
 * approved at a total, in a currency or at a rate nobody saw. Callers with no screen (MCP, the recurring run) pass none.
 */
import { formatAmount, formatMoney } from '@/lib/money/formatMoney';
import { sameCents, toScaledInteger } from '../shared/functionalAmounts';

export interface ShownInvoice {
  expectedTotal?: number;
  expectedCurrency?: string;
  expectedExchangeRate?: number;
  expectedContentDigest?: string;
}

/** `shown_digest`: the stored row's shown digest (invoicePdfModel.shownDigest, computed by the server caller: it hashes). */
interface Stored { total_amount?: unknown; currency_code?: unknown; exchange_rate?: unknown; shown_digest?: string }

const currencyOf = (code: unknown): string => (typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : 'ZAR');
const ONE = BigInt(1000000);
// In millionths, as the numeric(…, 6) column holds it: decimal digits rounded half away from zero, never a float
// product (4.0000005 × 10⁶ is 4000000.4999… as a float). A stored NULL or 0 converts at 1 (documentCurrency).
export const rateOf = (rate: unknown): bigint => {
  const units = typeof rate === 'number' || typeof rate === 'string' ? toScaledInteger(rate, 6) : null;
  return units !== null && units > BigInt(0) ? units : ONE;
};
const shownRate = (units: bigint): string => (Number(units) / 1e6).toString(); // census-ok: an exchange rate, not money
/** A stored or shown rate as the invoice page prints it, by the same rule the check compares (NULL or 0 is 1). */
export const rateText = (rate: unknown): string => shownRate(rateOf(rate));

/** "R 1 150.00", or "USD 1 150.00 at 18.5" for a foreign invoice. */
function describe(total: number, currency: string, rate: bigint): string {
  return currency === 'ZAR' ? formatMoney(total) : `${currency} ${formatAmount(total)} at ${shownRate(rate)}`;
}

const CONTENT_CHANGED = 'This invoice changed after it was shown (its lines, customer, dates or notes). Check it, then approve again.';

export class InvoiceStaleViewError extends Error {
  /** `shownNow`: the stored total when the total, currency or rate moved; null when only the content did. */
  constructor(shownNow: string | null) {
    super(shownNow === null ? CONTENT_CHANGED
      : `This invoice changed after it was shown: its total is now ${shownNow}. Check it, then approve again.`);
    this.name = 'InvoiceStaleViewError';
  }
}

/**
 * Throws when anything shown differs from the stored row: the total, currency and rate (the message names the stored
 * total), else the shown digest (invoicePdfModel: everything the PDF prints, with the approval digest; the message says the
 * content changed, never the total).
 */
export function assertShownIsStored(shown: ShownInvoice, stored: Stored): void {
  const total = Number(stored.total_amount ?? 0);
  const currency = currencyOf(stored.currency_code);
  const rate = rateOf(stored.exchange_rate);
  const moved = (shown.expectedTotal !== undefined && !sameCents(String(stored.total_amount ?? 0), shown.expectedTotal))
    || (shown.expectedCurrency !== undefined && currencyOf(shown.expectedCurrency) !== currency)
    || (shown.expectedExchangeRate !== undefined && rateOf(shown.expectedExchangeRate) !== rate);
  if (moved) throw new InvoiceStaleViewError(describe(total, currency, rate));
  if (shown.expectedContentDigest !== undefined && shown.expectedContentDigest !== stored.shown_digest) {
    throw new InvoiceStaleViewError(null);
  }
}
