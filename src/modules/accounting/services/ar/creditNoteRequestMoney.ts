/**
 * The money a credit-note create may carry, checked before any read or write: the REST route (credit-notes POST, its
 * fields taxRate / taxAmount) and MCP create_credit_note (tax_rate / tax_amount) both call this, so the two refuse the
 * same requests in the same words, each naming its own fields (#1701 review rounds 1-3). JSON numbers only (Number()
 * read "" / [] / false as 0 and true as 1), whole cents, a positive subtotal, a rate from 0 to 100 with at most two decimals (NUMERIC(5,2)), a VAT figure from 0
 * to the subtotal. A figure and a rate together must agree (vatAtRateCents on the subtotal is the figure, exact cents),
 * or the stored rate would contradict the stored VAT. Pure.
 */
import { hasWholeCents } from '@/lib/money/wholeCents';
import { exactCents } from '../shared/vatLineAmounts';
import { vatAtRateCents } from './creditNoteVatFigures';

const given = (v: unknown): boolean => v !== undefined && v !== null;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The names the caller's fields go by, in the messages. */
export interface CreditNoteMoneyFields { taxRate: string; taxAmount: string }
export const REST_MONEY_FIELDS: CreditNoteMoneyFields = { taxRate: 'taxRate', taxAmount: 'taxAmount' };
export const MCP_MONEY_FIELDS: CreditNoteMoneyFields = { taxRate: 'tax_rate', taxAmount: 'tax_amount' };

/** Why the request's subtotal / rate / VAT figure are refused (the 400's or the tool error's message), or null. */
export function creditNoteMoneyProblem(
  body: { subtotal: unknown; taxRate: unknown; taxAmount: unknown },
  fields: CreditNoteMoneyFields = REST_MONEY_FIELDS,
): string | null {
  const { subtotal, taxRate, taxAmount } = body;
  const { taxRate: rateName, taxAmount: figureName } = fields;
  // W1 family (P2.1): a negative subtotal posts inverted GL at approve.
  if (!isNumber(subtotal) || !(subtotal > 0)) return 'subtotal must be a positive amount';
  // Whole cents: 1.234 was stored rounded, and a third decimal let create and approve disagree by a cent.
  if (!hasWholeCents(subtotal)) return 'subtotal must be in whole cents';
  if (given(taxRate) && !(isNumber(taxRate) && taxRate >= 0 && taxRate <= 100)) return `${rateName} must be a number from 0 to 100`;
  // The column is NUMERIC(5,2): 15.005 would be stored as 15.01, which no longer gives the figure checked below.
  if (given(taxRate) && !hasWholeCents(taxRate as number)) return `${rateName} must have at most two decimals`;
  if (!given(taxAmount)) return null;
  if (!(isNumber(taxAmount) && taxAmount >= 0)) return `${figureName} must be a number of zero or more`;
  if (!hasWholeCents(taxAmount)) return `${figureName} must be in whole cents`;
  if (taxAmount > subtotal) return `${figureName} cannot be more than the subtotal`;
  if (given(taxRate) && vatAtRateCents(subtotal, taxRate as number) !== exactCents(taxAmount)) {
    return `${rateName} ${String(taxRate)} does not give ${figureName} ${taxAmount.toFixed(2)} on ${subtotal.toFixed(2)}: send one of them, or both agreeing`;
  }
  return null;
}
