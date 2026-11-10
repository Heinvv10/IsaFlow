/**
 * HOW THE FALLBACK TABLES ARE READ, for any one table (`packFallbackWidth.ts` has the rules; this is them, over a table
 * the caller holds). Split out so the commentary gate (`packProseBound`) can read the one style it needs
 * (`packProseFallbackData`, the regular label table) without loading every style into the editor (#1263 L2).
 * Client-safe: arithmetic only.
 */
import type { FallbackTable } from './packFallbackWidthData';

const BLOCK = 32;
/** Joiners and selectors add nothing to the glyph they join or select. */
const ADDS_NOTHING = /^[\p{M}\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;

function exactIndex(cp: number, ranges: ReadonlyArray<readonly [number, number]>): number {
  let offset = 0;
  for (const [from, to] of ranges) {
    if (cp >= from && cp <= to) return offset + cp - from;
    offset += to - from + 1;
  }
  return -1;
}

/** One code point's advance in whole pixels in `table` (its per-glyph `ranges`), at the size it is measured at. */
export function fallbackAdvanceIn(table: FallbackTable, ranges: ReadonlyArray<readonly [number, number]>, cp: number): number {
  const ch = String.fromCodePoint(cp);
  if (ADDS_NOTHING.test(ch)) return 0;
  const at = exactIndex(cp, ranges);
  let px: number;
  if (at >= 0) px = table.wide[cp] ?? Number.parseInt(table.exact[at]!, 36);
  else {
    const block = Math.floor(cp / BLOCK);
    px = block < table.blocks.length ? table.wide[block * BLOCK] ?? Number.parseInt(table.blocks[block]!, 36) : table.widest;
  }
  return px === 0 ? table.widest : px;
}

/** A cluster's cost in `table` at the size it is measured at (`measuredPx`), scaled to `sizePx` and rounded up. */
export function fallbackClusterIn(
  table: FallbackTable, ranges: ReadonlyArray<readonly [number, number]>, cluster: string, sizePx: number, measuredPx: number,
): number {
  let px = 0;
  for (const ch of cluster) px += fallbackAdvanceIn(table, ranges, ch.codePointAt(0)!);
  if (/[\uFE0F\u20E3]/u.test(cluster)) px = Math.max(px, table.emoji);
  return Math.ceil((px * sizePx) / measuredPx);
}
