/**
 * A ROW LABEL THAT CARRIES A MARK, AS PRINTED AND AS MEASURED (#1235 round 7, Hein's decision).
 *
 * Where Chromium breaks beside a combining mark or a variation selector, and how wide it draws a cluster that carries
 * one, depend on the mark, the base and the fallback face Chromium takes for both; the pair table and the fallback
 * tables cannot say. So such a label (`packPrintedText.carriesMarks`) is printed in a block of its own that may break
 * between any two graphemes and adds to its column's width only the floor it is set at (`pack-label-anywhere`:
 * `contain: inline-size; line-break: anywhere`, and a `min-width`), and is measured here:
 *  - its column is the other rows', or the label's FLOOR where that is wider: the print gives the block a `min-width`
 *    (`anywhereFloorPx`, stamped on the table's fit, `ComparativeTable`), and the fit gate counts it, so a grapheme the
 *    print cannot break is never wider than its column; where the floor leaves the figures no room the table does not
 *    fit and the pack is refused (`packFigureFloor`), never printed with the label over the figures (round 8);
 *  - its lines are a plain greedy fill of its graphemes into the column, each run of graphemes without a mark at its
 *    exact width as the ruler sets it, each grapheme that carries a mark at an upper bound: the widest advance of any
 *    glyph in production's fallback faces (`packFallbackWidthData.FALLBACK.widest`) for EVERY code point in it. One
 *    grapheme can hold several glyphs that each advance (seven emoji joined by ZWJ, a conjunct chain, a run of Hangul
 *    leading jamo or of prepended marks, a mark drawn on a dotted circle, stacked spacing marks), and none of ZWJ, a
 *    variation selector or a mark is zero-advance on every base (VS16 turns a text-default emoji into its emoji
 *    presentation, ZWJ changes how a conjunct is shaped, an off-script mark draws a dotted circle), so none is priced
 *    at nothing. A soft hyphen at the hyphen's width. Every width at or over the print's, and the fill greedy as
 *    Chromium's, the lines are never fewer (`printParity/packAnywhereLabelImage.test.ts`, in production). It may split
 *    a word, and it reads far more lines than the print where a script writes most letters with a mark: the demo's
 *    income statement in Thai prints as tall as in English (68.7mm), and the model reads it at 123.9mm. These labels
 *    are rare, and that is accepted (round 7). The floor is two glyphs at the least (174px at 9pt), so a table of them
 *    keeps a label column (round 7 left it its padding, 39.9px, where every label carried a mark).
 */
import { FALLBACK } from './packFallbackWidthData';
import { LABEL_STYLE, textExactPx, type FigureWeight } from './packFigureWidth';
import { clustersOf, fitUnitsPx } from './packGlyphRuler';

const LABEL_FONT_PX = 12;
const MARK = /\p{M}/u;

/** The most one code point of a grapheme that carries a mark can add, at `weight`: the widest fallback glyph. */
const codePointPx = (weight: FigureWeight): number => FALLBACK[LABEL_STYLE[weight]].widest;

/** The most a grapheme can be wide, at `weight`, without the ruler: the widest fallback glyph for each code point. */
export function markedClusterPx(cluster: string, weight: FigureWeight): number {
  return codePointPx(weight) * [...cluster].length;
}

/**
 * The narrowest a column can hold `labels` printed to break anywhere (the ones that carry a mark; null where none
 * does): the widest any of their graphemes can be (`markedClusterPx`, for one without a mark too), in whole pixels, so
 * the print's `min-width` is the model's to the unit. The footnote mark is a box of its own the print may break before,
 * and narrower than any grapheme of a marked label (two code points at the least).
 */
export function anywhereFloorPx(labels: ReadonlyArray<{ label: string; weight: FigureWeight }>): number | null {
  let floor: number | null = null;
  for (const { label, weight } of labels) {
    if (!MARK.test(label)) continue;
    for (const cluster of clustersOf(label)) floor = Math.max(floor ?? 0, Math.ceil(markedClusterPx(cluster, weight)));
  }
  return floor;
}

/** The width a line of `clusters` is fitted by: runs without a mark exact, a cluster with one at its upper bound. */
function lineExactPx(clusters: readonly string[], weight: FigureWeight): number {
  let px = 0;
  let run = '';
  for (const c of clusters) {
    if (MARK.test(c)) {
      if (run !== '') px += textExactPx(run, LABEL_FONT_PX, weight);
      run = '';
      px += markedClusterPx(c, weight);
    } else run += c;
  }
  return run === '' ? px : px + textExactPx(run, LABEL_FONT_PX, weight);
}

/**
 * The lines Chromium sets a label printed to break anywhere in, `availPx` wide: greedy, grapheme by grapheme, the
 * footnote mark (`markExactPx`, 0 for none) an item of its own after the last (the print may break before it).
 */
export function anywhereLineCount(label: string, markExactPx: number, weight: FigureWeight, availPx: number, guardPx: number): number {
  // Spaces collapsed to one, and none at the start (Chromium drops it); one at the end is kept, a mark may follow it. A
  // soft hyphen counts as the hyphen Chromium draws where a line ends at it (with nothing to say where, everywhere).
  const items = clustersOf(label.replace(/[ \t\n\r]+/g, ' ').replace(/^ /, '').replace(/\u00AD/g, '\u2010'));
  let lines = 1;
  let line: string[] = [];
  const fits = (candidate: readonly string[], extra: number): boolean => fitUnitsPx(lineExactPx(candidate, weight) + extra, LABEL_FONT_PX) <= availPx - guardPx;
  for (const c of items) {
    const candidate = [...line, c];
    if (line.length > 0 && !fits(candidate, 0)) { lines += 1; line = [c]; } else line = candidate;
  }
  if (markExactPx > 0 && line.length > 0 && !fits(line, markExactPx)) lines += 1;
  return lines;
}
