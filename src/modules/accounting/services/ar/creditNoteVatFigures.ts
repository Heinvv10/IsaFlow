/**
 * A credit note's VAT at a rate, and its total, in exact cents: the ONE rule what `createCreditNote` stores, what MCP
 * create_credit_note's replay expectation and duplicate-draft check compare, and what the new-note page shows
 * (#1701 round 3). The float product stored 4.99 on 33.30 at 15% where the exact figure is 5.00, and subtotal x 1.15
 * gave 3.79 for 3.30 where the note stores 0.50 + 3.30 = 3.80.
 *
 * Pure: safe in a client bundle (creditNoteTypedVat re-exports both for the server callers).
 */
import { parseDecimal, roundTo } from '../shared/functionalAmounts';
import { exactCents } from '../shared/vatLineAmounts';

/** ROUND(subtotal x rate / 100, 2) in exact decimal, half away from zero (33.30 at 15% is 5.00; the float product gave 4.99). */
export function vatAtRateCents(subtotal: number, rate: number): number {
  const s = parseDecimal(subtotal);
  const r = parseDecimal(rate);
  const d = roundTo({ digits: s.digits * r.digits, scale: s.scale + r.scale + 2 }, 2);
  return Number(d.digits * 10n ** BigInt(2 - d.scale));
}

/** The figure when one is given, else vatAtRateCents on the subtotal; the total their exact sum. */
export function creditNoteVatAndTotal(subtotal: number, taxRate: number, taxAmount: number | null | undefined):
  { taxAmount: number; totalAmount: number } {
  const tax = taxAmount != null ? exactCents(taxAmount) : vatAtRateCents(subtotal, taxRate);
  return { taxAmount: tax / 100, totalAmount: (exactCents(subtotal) + tax) / 100 };
}
