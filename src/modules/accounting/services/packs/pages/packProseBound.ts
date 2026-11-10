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
import { PROSE_ADVANCES, PROSE_ADVANCE_UNITS } from './packProseAdvanceData';
import { PROSE_FACES, PROSE_FALLBACK, PROSE_FALLBACK_RANGES } from './packProseFallbackData';
import { proseFill, type ProseSegment } from './packProseFill';
import type { ProseStyle } from './packProseStyles';

/** The size the fallback tables were measured at (`packFigureWidth`'s label size). */
const FALLBACK_MEASURED_PX = 12;

/** The table's mark for a code point the ruler does not set in the face: it is priced from the fallback tables. */
export const FALLBACK_MARK = parseInt('zzz', 36);

/** Each code point the faces set (and the ruler sets in them), and its bound in font units. */
const BOUND = ((): ReadonlyMap<number, number> => {
  const out = new Map<number, number>();
  let i = 0;
  for (const [from, to] of PROSE_FACES) {
    for (let cp = from; cp <= to; cp += 1) {
      const units = parseInt(PROSE_ADVANCES.slice(i * 3, i * 3 + 3), 36);
      if (units !== FALLBACK_MARK) out.set(cp, units);
      i += 1;
    }
  }
  return out;
})();

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * The most `text` can be wide set at `px` in the regular face (the table is the regular's: page 4's commentary is set in
 * it). A heavier weight is not bounded by it.
 */
export function boundPx(text: string, px: number): number {
  let units = 0;
  let fallback = 0;
  for (const { segment } of SEGMENTER.segment(text)) {
    const cps = Array.from(segment, (ch) => ch.codePointAt(0)!);
    if (cps.every((cp) => BOUND.has(cp))) for (const cp of cps) units += BOUND.get(cp)!;
    else fallback += fallbackClusterIn(PROSE_FALLBACK, PROSE_FALLBACK_RANGES, segment, px, FALLBACK_MEASURED_PX);
  }
  return (units * px) / PROSE_ADVANCE_UNITS + fallback;
}

/** The bounds, kept across calls: the editor costs the whole commentary again on every keystroke. */
const BOUNDS = new Map<string, number>();
const BOUNDS_KEPT = 100_000;

function keptBoundPx(text: string, px: number): number {
  const key = `${px}|${text}`;
  let width = BOUNDS.get(key);
  if (width === undefined) {
    if (BOUNDS.size >= BOUNDS_KEPT) BOUNDS.clear();
    width = boundPx(text, px);
    BOUNDS.set(key, width);
  }
  return width;
}

/** The lines `text` takes set in `style` (a regular one), `widthMm` wide, at its bound: never fewer than page 4's. */
export function proseLinesBound(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  if (style.weight !== 400) throw new Error(`proseLinesBound: the advance table is the regular face's; ${style.weight} is not bounded by it`);
  return proseFill(text, style, widthMm, (t, px, weight, hyphen) => {
    if (weight !== 400) throw new Error(`proseLinesBound: the advance table is the regular face's; ${weight} is not bounded by it`);
    // A soft hyphen that ends a line sets a hyphen (U+2010) after it: bounded as the code point it is.
    return keptBoundPx(hyphen ? `${t}\u2010` : t, px);
  });
}
