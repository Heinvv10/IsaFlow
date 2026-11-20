/**
 * The money a REST credit-note create (pages/api/accounting/credit-notes POST) may carry, checked before any read or
 * write (#1701 review rounds 1-2): JSON numbers only (Number() read "" / [] / false as 0 and true as 1), whole cents,
 * a positive subtotal, a rate from 0 to 100, a VAT figure from 0 to the subtotal. A figure and a rate together must
 * agree (ROUND(subtotal x rate) is the figure, exact cents), or the stored rate would contradict the stored VAT.
 * Pure.
 */
import { hasWholeCents } from '@/lib/money/wholeCents';
import { vatAtRateCents } from './creditNoteTypedVat';

const given = (v: unknown): boolean => v !== undefined && v !== null;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Why the request's subtotal / taxRate / taxAmount are refused (the 400's message), or null. */
export function creditNoteMoneyProblem(body: { subtotal: unknown; taxRate: unknown; taxAmount: unknown }): string | null {
  const { subtotal, taxRate, taxAmount } = body;
  // W1 family (P2.1): a negative subtotal posts inverted GL at approve.
  if (!isNumber(subtotal) || !(subtotal > 0)) return 'subtotal must be a positive amount';
  // Whole cents: 1.234 was stored rounded, and a third decimal let create and approve disagree by a cent.
  if (!hasWholeCents(subtotal)) return 'subtotal must be in whole cents';
  if (given(taxRate) && !(isNumber(taxRate) && taxRate >= 0 && taxRate <= 100)) return 'taxRate must be a number from 0 to 100';
  if (!given(taxAmount)) return null;
  if (!(isNumber(taxAmount) && taxAmount >= 0)) return 'taxAmount must be a number of zero or more';
  if (!hasWholeCents(taxAmount)) return 'taxAmount must be in whole cents';
  if (taxAmount > subtotal) return 'taxAmount cannot be more than the subtotal';
  if (given(taxRate) && vatAtRateCents(subtotal, taxRate as number) !== Math.round(taxAmount * 100)) {
    return `taxRate ${String(taxRate)} does not give taxAmount ${taxAmount.toFixed(2)} on ${subtotal.toFixed(2)}: send one of them, or both agreeing`;
  }
  return null;
}
