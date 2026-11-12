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
 * In prose and the gate (`marks`), an emoji sequence costs every code point at least an emoji, a keycap or a pictograph
 * with U+FE0F one emoji (`packFallbackWidthCore.fallbackClusterIn`, #1264 round 7).
 * Whole pixels rounded up, and at a size other than the one measured, scaled and rounded up: an upper bound for a
 * cluster without a mark. NOT for one that carries a mark: a non-spacing mark, a joiner and a selector are priced at nothing here (a spacing mark at its own advance, #1263 round 2),
 * and Chromium may set such a cluster in another face, base and all, and wider ("\u00AE" with U+036B is 9.98px against
 * 7). Nor for a letter that joins (its joined form can be wider than the advance measured alone: round 9). No priced
 * path gives either this table: a row label holding one is printed to break anywhere and priced per code point at the
 * widest fallback glyph (`packAnywhereLabel.ts`), and a KPI tile refuses any fallback glyph (`packKpiLayout.inPackFaces`).
 */
import { fallbackAdvanceIn, fallbackClusterIn } from './packFallbackWidthCore';
import { EXACT_RANGES, FALLBACK, type FallbackStyle } from './packFallbackWidthData';

export type { FallbackStyle } from './packFallbackWidthData';

/** One code point's advance in whole pixels, at the size the style is measured at. */
export function fallbackAdvancePx(cp: number, style: FallbackStyle): number {
  return fallbackAdvanceIn(FALLBACK[style], EXACT_RANGES, cp);
}

/** A cluster's cost at the size the style is measured at (`measuredPx`), scaled to `sizePx` and rounded up. */
export function fallbackClusterPx(cluster: string, style: FallbackStyle, sizePx: number, measuredPx: number, marks = false): number {
  return fallbackClusterIn(FALLBACK[style], EXACT_RANGES, cluster, sizePx, measuredPx, marks);
}
