/**
 * AN UPPER BOUND ON HOW WIDE THE PACK'S PROSE IS, WITHOUT THE FACES: the commentary gate's widths (Hein, 11-10). The
 * editor costs a commentary in the browser, where the font ruler cannot run, and the server's gate costs it the same
 * way, so neither may let through what page 4 cannot print. Each code point the faces set is charged its advance plus
 * the most any kerning pair adds to it (`packProseAdvanceData`, generated from the faces), which no shaping of a word
 * exceeds; a cluster the faces lack is charged from the fallback tables, as page 4's model charges it (the regular
 * label style's table, read by `packFallbackWidthCore` from the gate's own copy, `packProseFallbackData`, so the editor
 * loads one style's table and not four). The fill is page 4's own (`packProseFill.proseFill`: Chromium's breaks, each
 * piece whole), so the gate's lines are never fewer than the page's (`packProseAdvances.test.ts`), on any input,
 * a token wider than the line included. Client-safe: data and arithmetic only.
 */
import { fallbackClusterIn } from './packFallbackWidthCore';
import { graphemes } from './packGraphemes';
import { PROSE_ADVANCE_UNITS } from './packProseAdvanceData';
import { PROSE_FALLBACK, PROSE_FALLBACK_RANGES } from './packProseFallbackData';
import { BOUND, FALLBACK_MARK, floored } from './packProseFloor';
import { KEPT_CHARS, proseFill, SHAPED_CLUSTER, type ProseSegment } from './packProseFill';
import type { ProseStyle } from './packProseStyles';

/** The size the fallback tables were measured at (`packFigureWidth`'s label size). */
const FALLBACK_MEASURED_PX = 12;

export { FALLBACK_MARK };

/**
 * The most `text` can be wide set at `px` in the regular face (the table is the regular's: page 4's commentary is set in
 * it). A heavier weight is not bounded by it.
 */
export function boundPx(text: string, px: number): number {
  let units = 0;
  let fallback = 0;
  for (const { segment } of graphemes(text)) {
    const cps = Array.from(segment, (ch) => ch.codePointAt(0)!);
    // A cluster the page model does not shape (past SHAPED_CLUSTER) it charges the widest fallback glyph a code point:
    // so does the gate, which is never under the model (#1263 round 3).
    if (segment.length > SHAPED_CLUSTER) fallback += (cps.length * PROSE_FALLBACK.widest * px) / FALLBACK_MEASURED_PX;
    // A cluster with a ZWJ is priced from the fallback tables though the faces set every code point of it, as page 4's is
    // (`packGlyphRuler.runExactPx`'s `joiners`): beside a pictograph, production sets its neighbour in the emoji face.
    else if (!cps.includes(0x200d) && cps.every((cp) => BOUND.has(cp))) for (const cp of cps) units += BOUND.get(cp)!;
    else fallback += fallbackClusterIn(PROSE_FALLBACK, PROSE_FALLBACK_RANGES, segment, px, FALLBACK_MEASURED_PX, true);
  }
  return (units * px) / PROSE_ADVANCE_UNITS + fallback;
}

/**
 * The bounds, kept across calls: the editor costs the whole commentary again on every keystroke. Only short texts are
 * kept (a piece, a grapheme and its neighbour, a join): a key is a text, and tenant text is as long as a tenant makes it,
 * so a long one is measured and not kept, and the cache stays under BOUNDS_KEPT x KEPT_CHARS characters.
 */
const BOUNDS = new Map<number, Map<string, number>>();
const BOUNDS_KEPT = 100_000;
/** How many bounds are kept, across the sizes. */
let boundsKept = 0;

/** The longest text the bounds are kept for (what `packProseFillLinear.test.ts` holds under KEPT_CHARS). */
export function keptBoundLongest(): number {
  let longest = 0;
  for (const atPx of BOUNDS.values()) for (const key of atPx.keys()) longest = Math.max(longest, key.length);
  return longest;
}

/** Kept by size, then text: no key is built per call (the fill asks for one per grapheme of a long token). */
function keptBoundPx(text: string, px: number): number {
  if (text.length > KEPT_CHARS) return boundPx(text, px);
  let atPx = BOUNDS.get(px);
  if (atPx === undefined) { atPx = new Map(); BOUNDS.set(px, atPx); }
  let width = atPx.get(text);
  if (width === undefined) {
    if (boundsKept >= BOUNDS_KEPT) { BOUNDS.clear(); boundsKept = 0; atPx = new Map(); BOUNDS.set(px, atPx); }
    width = boundPx(text, px);
    atPx.set(text, width);
    boundsKept += 1;
  }
  return width;
}

/** The lines `text` takes set in `style` (a regular one), `widthMm` wide, at its bound: never fewer than page 4's (floor included). */
export function proseLinesBound(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  if (style.weight !== 400) throw new Error(`proseLinesBound: the advance table is the regular face's; ${style.weight} is not bounded by it`);
  const fill = proseFill(text, style, widthMm, (t, px, weight, hyphen) => {
    if (weight !== 400) throw new Error(`proseLinesBound: the advance table is the regular face's; ${weight} is not bounded by it`);
    // A soft hyphen that ends a line sets a hyphen (U+2010) after it: bounded as the code point it is.
    return keptBoundPx(hyphen ? `${t}\u2010` : t, px);
  });
  // Under any text the faces do not fully set, the em model's lines (`packProseFloor`), as the page model's.
  return floored(fill, text, style, widthMm);
}
