/**
 * How page 11's matter sentences write a count. Moved out of
 * `packMatterSources.ts` whole, for the 300-line limit.
 */
import { formatMoney } from '@/lib/format/money';

/**
 * EVERY MATTER ON THIS PAGE IS A SENTENCE A DIRECTOR READS, so it is written
 * the way a sentence is written.
 *
 * The rendered pack printed "is 739 day(s) overdue", "12 unreconciled bank
 * item(s)" and "across 3 account(s)" on the two governance pages: a
 * developer's plural, three times, in the part of the pack whose whole
 * purpose is to be read rather than scanned. `(s)` is what a template writes
 * when nobody has decided whether the sentence is about one thing or several,
 * and this model always knows which.
 */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${groupedCount(n)} ${n === 1 ? one : many}`;
}

/**
 * A COUNT, GROUPED LIKE EVERY OTHER FIGURE ON THE SHEET. A template literal
 * printed "1012 unreconciled bank items" beside a quantum column reading
 * `1 012`: two ways of writing a thousand in one table row. The pack has one
 * whole-number formatter and one separator (`GROUP_SEPARATOR`), and this is
 * that formatter. A count of nothing is the digit — "0 of 3 matters" — not
 * the en dash the money path gives a measured nil, which page 4's title can
 * reach when its panel names no finding.
 */
export function groupedCount(n: number): string {
  return n === 0 ? '0' : formatMoney(n, { pack: true });
}
