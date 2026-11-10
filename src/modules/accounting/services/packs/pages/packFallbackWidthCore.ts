/**
 * HOW THE FALLBACK TABLES ARE READ, for any one table (`packFallbackWidth.ts` has the rules; this is them, over a table
 * the caller holds). Split out so the commentary gate (`packProseBound`) can read the one style it needs
 * (`packProseFallbackData`, the regular label table) without loading every style into the editor (#1263 L2).
 * Client-safe: arithmetic and data only.
 */
import { FALLBACK_MARKS } from './packFallbackMarkData';
import type { FallbackTable } from './packFallbackWidthData';

const BLOCK = 32;
/**
 * Joiners, selectors and the marks that do not space (Mn, Me) add nothing to the glyph they join or select. A SPACING
 * mark (Mc: the Myanmar, Khmer and Indic vowel signs and medials) takes room of its own, and costs its own advance: at
 * nothing, Burmese prose read 18% narrower than production sets it (#1263 round 2).
 */
const ADDS_NOTHING = /^[\p{Mn}\p{Me}\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;

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

/** What each mark of the dictionary-broken scripts adds, measured in production's image: [in a word, elsewhere]. */
const MARKS = new Map<number, readonly [number, number]>(FALLBACK_MARKS.map(([cp, inWord, elsewhere]) => [cp, [inWord, elsewhere]]));
const SA_SCRIPTS = [/\p{Script=Thai}/u, /\p{Script=Lao}/u, /\p{Script=Myanmar}/u, /\p{Script=Khmer}/u, /\p{Script=Tai_Le}/u,
  /\p{Script=New_Tai_Lue}/u, /\p{Script=Tai_Tham}/u, /\p{Script=Tai_Viet}/u, /\p{Script=Ahom}/u];
const scriptOf = (ch: string): number => SA_SCRIPTS.findIndex((re) => re.test(ch));

/**
 * A cluster's cost in `table` at the size it is measured at (`measuredPx`), scaled to `sizePx` and rounded up. A mark of
 * a dictionary-broken script costs what it adds in production's image (`packFallbackMarkData`), not its general
 * category's guess or its advance alone: after a letter of its own script, what it adds in a word; after itself, what it
 * adds there; after anything else, the widest glyph (#1263 round 3: "m" or a Myanmar digit with a Myanmar vowel sign, a
 * Khmer vowel sign three times over, Lao U+0ECE).
 */
export function fallbackClusterIn(
  table: FallbackTable, ranges: ReadonlyArray<readonly [number, number]>, cluster: string, sizePx: number, measuredPx: number,
): number {
  let px = 0;
  const cps = Array.from(cluster);
  // A mark is written on a letter of its own script; on anything else (a Latin letter, a digit) the print sets it on a
  // dotted circle in a face of its own, wider than any table here measures: it costs the widest fallback glyph.
  const base = cps[0] !== undefined && /^\p{L}$/u.test(cps[0]) ? scriptOf(cps[0]) : -1;
  cps.forEach((ch, i) => {
    const mark = MARKS.get(ch.codePointAt(0)!);
    if (mark === undefined) { px += fallbackAdvanceIn(table, ranges, ch.codePointAt(0)!); return; }
    if (i === 0 || base < 0 || base !== scriptOf(ch)) px += table.widest;
    else px += cps[i - 1] === ch ? mark[1] : mark[0];
  });
  if (/[\uFE0F\u20E3]/u.test(cluster)) px = Math.max(px, table.emoji);
  return Math.ceil((px * sizePx) / measuredPx);
}
