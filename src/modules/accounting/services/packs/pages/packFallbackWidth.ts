/**
 * WHAT A GLYPH OUTSIDE THE PACK'S OWN FACE COSTS: a cluster Chromium sets in the render host's fallback fonts.
 *
 * Its width is a fact about production's Gotenberg image, measured there (`packFallbackWidthData.ts`; the velo test
 * `tests/unit/printParity/packFallbackWidths.test.ts` holds the tables to the image), and the print page refuses to
 * print a pack that uses one on a host whose fallback fonts are not those (`packFallbackGuard.ts`). Per style:
 *  - a code point of the per-glyph ranges costs its own advance, any other the widest advance of its block of 32, and
 *    one beyond the tables the widest of all; a code point measured at nothing that is not a mark, a joiner or a
 *    selector (a control, a format character, an unassigned one) costs the widest too;
 *  - a cluster costs the sum of its code points (a family, a skin-toned hand, a flag: at least as wide as the one
 *    glyph Chromium may draw for it), and an emoji presentation (a VS16 sequence, a keycap) at least the widest emoji
 *    presentation: "ℹ" with VS16 (U+2139 U+FE0F) is an 18px emoji, not the 4px letter its first code point is.
 * Whole pixels rounded up, and at a size other than the one measured, scaled and rounded up: an upper bound for a
 * cluster without a mark. NOT for one that carries a mark: a mark, a joiner and a selector are priced at nothing here,
 * and Chromium may set such a cluster in another face, base and all, and wider ("\u00AE" with U+036B is 9.98px against
 * 7). Nor for a letter that joins (its joined form can be wider than the advance measured alone: round 9). No priced
 * path gives either this table: a row label holding one is printed to break anywhere and priced per code point at the
 * widest fallback glyph (`packAnywhereLabel.ts`), and a KPI tile refuses any fallback glyph (`packKpiLayout.inPackFaces`).
 */
import { EXACT_RANGES, FALLBACK, type FallbackStyle } from './packFallbackWidthData';

export type { FallbackStyle } from './packFallbackWidthData';

const BLOCK = 32;
/** Joiners and selectors add nothing to the glyph they join or select. */
const ADDS_NOTHING = /^[\p{M}\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;

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
