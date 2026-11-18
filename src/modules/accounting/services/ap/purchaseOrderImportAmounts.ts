/**
 * The money of an imported purchase order (bulk_create_purchase_orders), in whole cents. Pure: no I/O.
 *
 * A line's ex-VAT amount (`line_total`) and VAT (`tax_amount`) are, in order of preference:
 *   1. the source system's own figures, when the caller sends them (Sage's Exclusive and Tax per line). Stored as sent,
 *      because the source's arithmetic is what its totals add up to: a discount, an inclusive document, or a unit
 *      price with more decimals than po_items keeps (NUMERIC(15,2)) all make quantity x unit price differ from them.
 *      The VAT must still agree with the line amount at the line's rate within 2 cents (a swapped or mistyped field
 *      is refused, rounding is not);
 *   2. otherwise computed. Exclusive: net = round(qty x price), VAT = round(net x rate). Inclusive (the source
 *      document's prices included VAT, as Sage computes it): gross = round(qty x price x (1 + rate)), VAT =
 *      round(gross x rate / (1 + rate)), net = gross - VAT. `unit_price` is ex-VAT either way.
 * The PO's subtotal, VAT and total are the sums of its lines. When the caller sends the source's own totals
 * (`expected`), each one sent must equal the sum to the cent, or the PO is refused naming both figures.
 */

export interface ImportLineMoney {
  quantity: number;
  /** Ex-VAT unit price, any precision. */
  unitPrice: number;
  /** VAT rate in percent, 0-100. */
  taxRate: number;
  /** The source's ex-VAT line amount, whole cents. */
  lineTotal?: number;
  /** The source's VAT on the line, whole cents. Only with lineTotal. */
  taxAmount?: number;
}

export interface LineCents { net: number; tax: number }
export interface PoCents { subtotal: number; tax: number; total: number }

export interface ExpectedTotals { subtotal?: number; taxAmount?: number; total?: number }

/** Whole cents of a non-negative amount, rounding half up; robust to binary representation (1.005 -> 101). */
export function cents(amount: number): number {
  return Math.round(Number((amount * 100).toPrecision(15)));
}

/** VAT agrees with the line amount within this many cents: the source's own rounding, never a wrong figure. */
export const TAX_TOLERANCE_CENTS = 2;

/** One line's cents, or the refusal text. */
export function lineCents(line: ImportLineMoney, inclusive: boolean): LineCents | string {
  const vat = line.taxRate / 100;
  if (line.lineTotal !== undefined) {
    const net = cents(line.lineTotal);
    const expectedTax = cents(line.lineTotal * vat);
    if (line.taxAmount === undefined) return { net, tax: expectedTax };
    const tax = cents(line.taxAmount);
    if (Math.abs(tax - expectedTax) > TAX_TOLERANCE_CENTS) {
      return `tax_amount ${fmt(tax)} does not match line_total ${fmt(net)} at ${line.taxRate}% (expected about ${fmt(expectedTax)})`;
    }
    return { net, tax };
  }
  if (line.taxAmount !== undefined) return 'tax_amount needs line_total (send both, or neither)';
  if (inclusive) {
    const gross = cents(line.quantity * line.unitPrice * (1 + vat));
    const tax = cents((gross / 100) * (vat / (1 + vat)));
    return { net: gross - tax, tax };
  }
  const net = cents(line.quantity * line.unitPrice);
  return { net, tax: cents((net / 100) * vat) };
}

export function poCents(lines: readonly LineCents[]): PoCents {
  const subtotal = lines.reduce((s, l) => s + l.net, 0);
  const tax = lines.reduce((s, l) => s + l.tax, 0);
  return { subtotal, tax, total: subtotal + tax };
}

/** The refusal text when a sent total differs from the lines' sum, or null. */
export function expectedTotalsRefusal(got: PoCents, expected: ExpectedTotals | undefined): string | null {
  if (!expected) return null;
  const pairs: [string, number | undefined, number][] = [
    ['subtotal', expected.subtotal, got.subtotal],
    ['tax_amount', expected.taxAmount, got.tax],
    ['total', expected.total, got.total],
  ];
  for (const [name, sent, sum] of pairs) {
    if (sent !== undefined && cents(sent) !== sum) {
      return `expected_totals.${name} is ${fmt(cents(sent))} but the lines add up to ${fmt(sum)}`;
    }
  }
  return null;
}

export const toRand = (c: number): number => c / 100;
const fmt = (c: number): string => (c / 100).toFixed(2);
