/**
 * Money a row carries that this import does not read (team-lead decision after round 12). PURE. Dropped silently, it would book a PO at
 * other figures (a 50% line discount booked at full price), so such a field refuses the row, failing closed, but only when its value is
 * not zero: most exports carry `Discount: 0`.
 *   - a discount: a key holding a discount word (disc, markdown, allowance, percentoff, rebate; compared by fieldKey, so any case,
 *     separator or accent): `po_discount_unsupported` on a PO or a line, `item_discount_unsupported` on an item;
 *   - any other key that looks like money (amount, price, total, charge: surcharge and delivery charge included) on a PO or a line and is not a field the parser
 *     reads: `po_money_field_unsupported`. A field the real export turns out to carry is added, with its check, to the reviewed list
 *     (the parsers' PO_FIELDS / LINE_FIELDS and sageLineMoney), never dropped.
 * Each reason carries its mark, which picks the refusal code.
 */
import { fieldKey, type Raw } from './sageValues';

export const PO_DISCOUNT_MARK = '(po_discount_unsupported)';
export const ITEM_DISCOUNT_MARK = '(item_discount_unsupported)';
export const MONEY_FIELD_MARK = '(po_money_field_unsupported)';

/** Words of a discount, inside a normalised key ('disc' covers discount). */
const DISCOUNT_WORDS = ['disc', 'markdown', 'allowance', 'percentoff', 'rebate'];
/** 'charge' covers surcharge and delivery charge; each word here is held by a test. */
const MONEY_WORDS = ['amount', 'price', 'total', 'charge'];
const isDiscountKey = (key: string): boolean => DISCOUNT_WORDS.some((w) => key.includes(w));

/** Absent, null, false, blank, or a number / numeric text that is zero: nothing to drop. */
export function isZeroish(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return true;
  if (typeof v === 'number') return v === 0;
  return typeof v === 'string' && /^\s*([+-]?(0+(\.0*)?|\.0+))?\s*$/.test(v);
}

/** The discounts of a row that are not zero, worded with `mark`. */
export function discountReasons(o: Raw, mark: string): string[] {
  return Object.keys(o).filter((k) => isDiscountKey(fieldKey(k)) && !isZeroish(o[k]))
    .map((k) => `${k} is ${JSON.stringify(o[k])}: a discount is not imported (the row would be booked at its undiscounted figures) ${mark}`);
}

/** The money-like keys of a PO or a line, outside the fields read (and the discounts, reasoned above), whose value is not zero. */
export function unreadMoneyReasons(o: Raw, read: readonly string[]): string[] {
  const readKeys = new Set(read.map(fieldKey));
  return Object.keys(o).filter((k) => {
    const key = fieldKey(k);
    return !readKeys.has(key) && !isDiscountKey(key) && MONEY_WORDS.some((w) => key.includes(w)) && !isZeroish(o[k]);
  }).map((k) => `${k} is ${JSON.stringify(o[k])}: a money field this import does not read; it is refused, never dropped (if the real export carries it, add it, with its check, to the reviewed list in sageMoneyFields.ts) ${MONEY_FIELD_MARK}`);
}
