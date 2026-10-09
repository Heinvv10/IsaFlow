/**
 * The one pricing of a customer-invoice line and of the totals over its lines,
 * shared by create (customerInvoiceCreateService), the draft edit
 * (customerInvoiceDraftEdit) and the new / edit page previews, so the figure
 * the operator sees is the figure stored and posted.
 *
 *   line     = ROUND(q × p × (100 − discount%) / 100, 2),
 *              q, p = ROUND(qty, 2), ROUND(price, 2) — as their numeric(…, 2) columns store them,
 *              so a stored line re-prices to its own amount
 *   subtotal = Σ line            (the header foots to its own lines)
 *   tax      = ROUND(subtotal × rate% / 100, 2)
 *   total    = subtotal + tax
 *
 * Exact decimal, half away from zero — as numeric ROUND() does — never float:
 * `Math.round(x * 100) / 100` rounds 1.005 to 1.00 (functionalAmounts.ts).
 *
 * Pure: imports only functionalAmounts (itself import-free), safe in a client bundle.
 */
import { parseDecimal, roundTo, type Decimal } from '../shared/functionalAmounts';

const mul = (a: Decimal, b: Decimal): Decimal => ({ digits: a.digits * b.digits, scale: a.scale + b.scale });
const atScale = (d: Decimal, scale: number): bigint => d.digits * 10n ** BigInt(scale - d.scale);
const cents = (d: Decimal): bigint => atScale(roundTo(d, 2), 2);
const rands = (c: bigint): number => Number(c) / 100;

/** A quantity or unit price as its numeric(…, 2) column stores it. */
export const toColumnCents = (n: number): number => rands(cents(parseDecimal(n)));

/** The line's amount (see the header). Throws NotADecimalError on a non-finite input. */
export function invoiceLineAmount(quantity: number, unitPrice: number, discount = 0): number {
  const d = parseDecimal(discount);
  const keptPercent: Decimal = { digits: atScale({ digits: 100n, scale: 0 }, d.scale) - d.digits, scale: d.scale };
  const q = roundTo(parseDecimal(quantity), 2);
  const p = roundTo(parseDecimal(unitPrice), 2);
  const product = mul(mul(q, p), keptPercent);
  return rands(cents({ digits: product.digits, scale: product.scale + 2 }));
}

export interface InvoiceTotals {
  subtotal: number;
  tax: number;
  total: number;
}

/** The header over already-priced line amounts (each a whole number of cents) at `ratePercent`. */
export function invoiceTotals(lineAmounts: readonly number[], ratePercent: number): InvoiceTotals {
  const subtotal = lineAmounts.reduce((s, a) => s + cents(parseDecimal(a)), 0n);
  const r = parseDecimal(ratePercent);
  const tax = cents({ digits: subtotal * r.digits, scale: r.scale + 4 });
  return { subtotal: rands(subtotal), tax: rands(tax), total: rands(subtotal + tax) };
}

const finite = (...ns: number[]): boolean => ns.every((n) => Number.isFinite(n) && Math.abs(n) < 1e15);

/** For a form preview: a field mid-edit (empty, NaN, absurd) prices as 0 rather than throwing. */
export const previewLineAmount = (quantity: number, unitPrice: number, discount: number): number =>
  (finite(quantity, unitPrice, discount) ? invoiceLineAmount(quantity, unitPrice, discount) : 0);

/** For a form preview: as invoiceTotals, or zeros while a rate is mid-edit. */
export const previewTotals = (lineAmounts: readonly number[], ratePercent: number): InvoiceTotals =>
  (finite(ratePercent, ...lineAmounts) ? invoiceTotals(lineAmounts, ratePercent) : { subtotal: 0, tax: 0, total: 0 });

/**
 * The discount a stored line carries, for the edit form: there is no discount
 * column, so it is read back from amount < qty × price. The shortest decimal
 * (1 to 6 places) that re-prices to exactly the stored amount, so saving the
 * form unchanged moves nothing; 0 when the amount is not below qty × price.
 */
export function discountFromAmount(quantity: number, unitPrice: number, amount: number): number {
  if (!finite(quantity, unitPrice, amount)) return 0;
  const base = invoiceLineAmount(quantity, unitPrice, 0);
  if (!(base > 0 && amount < base)) return 0;
  const exact = (1 - amount / base) * 100;
  for (let places = 1; places <= 6; places++) {
    const d = Number(exact.toFixed(places));
    if (d >= 0 && d <= 100 && invoiceLineAmount(quantity, unitPrice, d) === amount) return d;
  }
  return Number(exact.toFixed(6));
}
