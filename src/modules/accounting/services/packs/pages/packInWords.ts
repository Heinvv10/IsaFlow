/**
 * The pack's one "a, b and c" joiner for a list set in prose. Split out of
 * `packPageBlocks.ts` for the 300-line cap: the highlights, trends and bridge
 * block modules all join labels with it, so it is a leaf none of them owns.
 */

/** "a, b and c", or "a" — the same joiner `packTrendCrossReference` uses on
 *  the note beside this one. */
export function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
