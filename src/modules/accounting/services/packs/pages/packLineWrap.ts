/**
 * LINE BREAKING OVER EXACT PIXEL WIDTHS: how many lines a text's pieces take in a box of a given width, each
 * candidate line measured whole, as Chromium shapes it. The statement table's labels and headings
 * (`packTableLayout.ts`) fill with it. Where text may break is `packLineBreaks.ts` (measured in Chromium, which is not
 * UAX 14).
 */
import type { Piece } from './packLineBreaks';

export type { Piece } from './packLineBreaks';

/** One breakable piece of text by its width, for the narrowest width (`minPx`). */
export interface Run { w: number; gap: number }

/**
 * Slack kept off the box when deciding whether a piece still fits the line, set from the model's measured error.
 * Measured in `packTableLayout.test.ts` over every caller of the fill (`packTableLayout.ts`: the row labels and the
 * column headings of every statement table, pages 5 to 8, of a stratified sample of packs, under production's
 * engine): the model's columns are within 0.09px of Chromium's and wider than Chromium's by at most 0.024px; a line is
 * measured whole, as Chromium sets it (`asChromiumSets`). 0.03px covers that widest error, and stays under the
 * tightest real fit the adversary found (a label 0.031px inside its column, which a half-pixel guard wrapped, and six
 * packs were trimmed for it).
 *
 * The error each way: smaller than the columns' worst over-width, a column modelled wider than Chromium's could fit a
 * piece Chromium wraps, a line too few (the model is shorter than the print, and the sheet runs past its foot; the
 * test fails on any). Larger, more pieces ending near their line take a line too many (the model is taller, and a page
 * is trimmed or refused that would have fitted). Where the model's column is narrower than Chromium's, a piece within
 * that of its line takes a line too many whatever the guard: the test counts those near ties and holds the height
 * never short. Not covered: a line Chromium's single-precision sum puts a 1/64px unit over the model's AND that ends
 * within 0.03px of a column modelled too wide; the sample has none. Balance sheet labels that wrap near a tie set
 * Chromium's lines at this guard and a line too many at 0.5.
 */
export const WRAP_GUARD_PX = 0.03;

/**
 * A greedy fill of `parts` into lines of `avail` pixels, each candidate line measured WHOLE by `lineWidth` (Chromium
 * shapes a line as one run: kerning across a space and the rounding of one width, not a sum of rounded pieces);
 * `marker` is a footnote mark that stays with the last part.
 */
export function linesForText(
  parts: readonly Piece[], lineWidth: (text: string) => number, marker: number, avail: number, guardPx: number = WRAP_GUARD_PX,
): number {
  let lines = 1;
  let line = '';
  parts.forEach((part, i) => {
    const mark = i === parts.length - 1 ? marker : 0;
    const candidate = line === '' ? part.text : `${line}${part.spaced ? ' ' : ''}${part.text}`;
    if (line !== '' && lineWidth(candidate) + mark > avail - guardPx) { lines += 1; line = part.text; } else line = candidate;
  });
  return lines;
}

/** The narrowest `runs` can be set: the widest piece, the footnote mark counted with the LAST one it sits after. */
export function minPx(runs: readonly Run[], marker: number): number {
  return Math.max(0, ...runs.map((run, i) => run.w + (i === runs.length - 1 ? marker : 0)));
}
