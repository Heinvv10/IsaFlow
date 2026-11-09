/**
 * WHAT A GLYPH OUTSIDE THE PACK'S OWN FACE COSTS: a cluster Chromium sets in the render host's fallback fonts.
 *
 * Its width is a fact about production's Gotenberg image, measured there (`packFallbackWidthData.ts`; the velo test
 * `tests/unit/printParity/packFallbackWidths.test.ts` holds the tables to the image), and the print page refuses to
 * print a pack that uses one on a host whose fallback fonts are not those (`packFallbackGuard.ts`). Per style:
 *  - a code point of the per-glyph ranges costs its own advance, any other the widest advance of its block of 32, and
 *    one beyond the tables the widest of all; a code point measured at nothing that is not a mark or a joiner (a
 *    control, a format character, an unassigned one) costs the widest too; a combining mark (a selector among them) the
 *    most it adds to any base in production (`packFallbackMarkData.ts`: "A\u20D7" is 13.36px at 12px/400, not A's 8);
 *  - a cluster costs the sum of its code points (a family, a skin-toned hand, a flag: at least as wide as the one
 *    glyph Chromium may draw for it), and an emoji presentation (a VS16 sequence, a keycap) at least the widest emoji
 *    presentation: "ℹ" with VS16 (U+2139 U+FE0F) is an 18px emoji, not the 4px letter its first code point is.
 * Whole pixels rounded up: an upper bound, never short. At a size other than the one measured, scaled and rounded up.
 */
import { MARK_ADDS } from './packFallbackMarkData';
import { EXACT_RANGES, FALLBACK, type FallbackStyle } from './packFallbackWidthData';

export type { FallbackStyle } from './packFallbackWidthData';

const BLOCK = 32;
/** Joiners add nothing to the glyphs they join. */
const ADDS_NOTHING = /^[\u200C\u200D]$/u;
const MARK = /^\p{M}$/u;

/** Each style's marks and the most each adds to a base, read once from `packFallbackMarkData.ts`. */
const MARKS = new Map<FallbackStyle, Map<number, number>>();
function markAddsPx(cp: number, style: FallbackStyle): number {
  let table = MARKS.get(style);
  if (table === undefined) {
    table = new Map();
    for (const run of MARK_ADDS[style].split(',')) {
      if (run === '') continue;
      const [range, px] = run.split(':');
      const [from, to] = range!.split('-').map((d) => Number.parseInt(d, 36));
      for (let c = from!; c <= (to ?? from!); c += 1) table.set(c, Number.parseInt(px!, 36));
    }
    MARKS.set(style, table);
  }
  return table.get(cp) ?? 0;
}

function exactIndex(cp: number): number {
  let offset = 0;
  for (const [from, to] of EXACT_RANGES) {
    if (cp >= from && cp <= to) return offset + cp - from;
    offset += to - from + 1;
  }
  return -1;
}

/** One code point's advance in whole pixels, at the size the style is measured at. */
export function fallbackAdvancePx(cp: number, style: FallbackStyle): number {
  const table = FALLBACK[style];
  const ch = String.fromCodePoint(cp);
  if (ADDS_NOTHING.test(ch)) return 0;
  // A mark costs what it adds to a base in production at most (a selector, most accents: nothing).
  if (MARK.test(ch)) return markAddsPx(cp, style);
  const at = exactIndex(cp);
  let px: number;
  if (at >= 0) px = table.wide[cp] ?? Number.parseInt(table.exact[at]!, 36);
  else {
    const block = Math.floor(cp / BLOCK);
    px = block < table.blocks.length ? table.wide[block * BLOCK] ?? Number.parseInt(table.blocks[block]!, 36) : table.widest;
  }
  return px === 0 ? table.widest : px;
}

/** A cluster's cost at the size the style is measured at (`measuredPx`), scaled to `sizePx` and rounded up. */
export function fallbackClusterPx(cluster: string, style: FallbackStyle, sizePx: number, measuredPx: number): number {
  let px = 0;
  for (const ch of cluster) px += fallbackAdvancePx(ch.codePointAt(0)!, style);
  if (/[\uFE0F\u20E3]/u.test(cluster)) px = Math.max(px, FALLBACK[style].emoji);
  return Math.ceil((px * sizePx) / measuredPx);
}
