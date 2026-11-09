/**
 * A ROW LABEL THAT CARRIES A MARK, AS PRINTED AND AS MEASURED (#1235 round 7, Hein's decision).
 *
 * Where Chromium breaks beside a combining mark or a variation selector, and how wide it draws a cluster that carries
 * one, depend on the mark, the base and the fallback face Chromium takes for both; the pair table and the fallback
 * tables cannot say. So such a label (`packPrintedText.carriesMarks`) is printed in a block of its own that may break
 * between any two graphemes and adds nothing to its column's width (`pack-label-anywhere`: `contain: inline-size;
 * line-break: anywhere`), and is measured here:
 *  - its column is the other rows' (it adds its indent and padding only, as the print does);
 *  - its lines are a plain greedy fill of its graphemes into the column, each run of graphemes without a mark at its
 *    exact width as the ruler sets it, each grapheme that carries a mark at an upper bound: the widest advance of any
 *    glyph in production's fallback faces (`packFallbackWidthData.FALLBACK.widest`), one more for each spacing mark in
 *    it; a soft hyphen at the hyphen's width. Every width at or over the print's, and the fill greedy as Chromium's, the
 *    lines are never fewer (`printParity/packAnywhereLabelImage.test.ts`: 1.4 million settings in production). It may split
 *    a word, and read a line or two more than the print: these labels are rare, and that is accepted.
 */
import { FALLBACK } from './packFallbackWidthData';
import { LABEL_STYLE, textExactPx, type FigureWeight } from './packFigureWidth';
import { clustersOf, fitUnitsPx } from './packGlyphRuler';

const LABEL_FONT_PX = 12;
const MARK = /\p{M}/u;
const SPACING_MARK = /\p{Mc}/gu;

/** The most a grapheme that carries a mark can be wide, at `weight`: the widest fallback glyph, and one a spacing mark. */
export function markedClusterPx(cluster: string, weight: FigureWeight): number {
  return FALLBACK[LABEL_STYLE[weight]].widest * (1 + (cluster.match(SPACING_MARK)?.length ?? 0));
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
