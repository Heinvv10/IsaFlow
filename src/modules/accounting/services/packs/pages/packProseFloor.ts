/**
 * THE FLOOR UNDER PROSE THE FACES DO NOT FULLY SET (#1264 round 9, Hein 11-11).
 *
 * Eight rounds of review kept finding a new class of text the width model (`packProseLines`, the gate `packProseBound`)
 * read a line short: a fallback glyph's pairs and states (a mark the primary face lacks makes Chromium draw LATER symbols
 * in a wider face for the rest of the text; a ZWNJ between Khmer consonants; ...) are facts about production's render
 * host that no table of single glyphs can hold. The em model that wrapped prose until #1263 (`packTextMetrics.wrapEms`:
 * a class per character, 1.12 over) is dearer on those texts than any state of the host has made them. So:
 *
 *   any prose text holding a code point the pack's faces do not set is priced at max(the width model, the em model),
 *   per text block, in LINES (the unit a page's height is made of, so the floor is real in the page and in the gate);
 *   text the faces set in full keeps the width model unchanged.
 *
 * The same test and the same floor decide the page model and the gate, so the gate's lines stay at or over the page's.
 * Not a per-class patch: nothing here names a script, a mark or a sequence. Client-safe: data and arithmetic only.
 */
import { PROSE_ADVANCES } from './packProseAdvanceData';
import { PROSE_FACES } from './packProseFallbackData';
import { PAST_ANY_PAGE, type ProseSegment } from './packProseFill';
import type { ProseStyle } from './packProseStyles';
import { wrappedLines } from './packTextMetrics';

/** The table's mark for a code point the ruler does not set in the face: it is priced from the fallback tables. */
export const FALLBACK_MARK = parseInt('zzz', 36);

/** Each code point the faces set (and the ruler sets in them), and its bound in font units. */
export const BOUND = ((): ReadonlyMap<number, number> => {
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

/** Collapsible white space prints nothing (`packProseFill`): it is no glyph the faces lack. */
const NO_GLYPH = /[\t\n\r]/;

/** Does `text` hold a code point the faces do not set (so that some of it is drawn in the render host's fallback fonts)? */
export function holdsUnsetCodePoint(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0x7e || cp < 0x20) { if (!BOUND.has(cp) && !NO_GLYPH.test(ch)) return true; }
  }
  return false;
}

/**
 * The floor, in lines: the em model's lines for `text` (or its segments, joined) at `style`'s size across `widthMm` if
 * it holds a code point the faces do not set, else 0. A text past the prose cap is already charged PAST_ANY_PAGE.
 */
export function floorLines(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  const full = typeof text === 'string' ? text : text.map((s) => s.text).join('');
  return holdsUnsetCodePoint(full) ? wrappedLines(full, style.pt, widthMm) : 0;
}

/** `fill` (the width model's lines), raised to the floor where the text holds a code point the faces do not set. */
export function floored(fill: number, text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  return fill >= PAST_ANY_PAGE ? fill : Math.max(fill, floorLines(text, style, widthMm));
}
