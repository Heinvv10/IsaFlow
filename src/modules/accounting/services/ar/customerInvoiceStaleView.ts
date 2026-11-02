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
/**
 * A rate in millionths, as the numeric(…, 6) column holds it: decimal digits rounded half away from zero, never a
 * float product (4.0000005 × 10⁶ is 4000000.4999… as a float). Null for anything that is not a plain decimal.
 */
function micro(value: unknown): bigint | null {
  const text = typeof value === 'number'
    ? (Number.isFinite(value) ? (/e/i.test(String(value)) ? value.toFixed(12) : String(value)) : '')
    : String(value ?? '').trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (!m[2] && !m[3])) return null;
  const frac = (m[3] ?? '').padEnd(7, '0');
  let units = BigInt(`${m[2] || '0'}${frac.slice(0, 6)}`);
  if (Number(frac[6]) >= 5) units += BigInt(1);
  return m[1] ? -units : units;
}
const ONE = BigInt(1000000);
// A stored NULL or 0 converts at 1 (documentCurrency).
const rateOf = (rate: unknown): bigint => {
  const units = micro(rate);
  return units !== null && units > BigInt(0) ? units : ONE;
};
const shownRate = (units: bigint): string => (Number(units) / 1e6).toString(); // census-ok: an exchange rate, not money

/** "R 1 150.00", or "USD 1 150.00 at 18.5" for a foreign invoice. */
function describe(total: number, currency: string, rate: bigint): string {
  return currency === 'ZAR' ? formatMoney(total) : `${currency} ${formatAmount(total)} at ${shownRate(rate)}`;
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
    || (shown.expectedExchangeRate !== undefined && rateOf(shown.expectedExchangeRate) !== rate);
  if (stale) throw new InvoiceStaleViewError(describe(total, currency, rate));
}
