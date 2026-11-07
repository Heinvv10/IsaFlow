/**
 * LINE BREAKING OVER EXACT PIXEL WIDTHS: how many lines a text's pieces take in a box of a given width, each
 * candidate line measured whole, as Chromium shapes it. The statement table's labels and headings
 * (`packTableLayout.ts`) fill with it. Where text may break is `packLineBreaks.ts` (measured in Chromium, which is not
 * UAX 14).
 */
import type { Piece } from './packLineBreaks';
import type { PageOrientation } from './packTextMetrics';

export type { Piece } from './packLineBreaks';

/** One breakable piece of text by its width, for the narrowest width (`minPx`). */
export interface Run { w: number }

/**
 * Slack kept off the box when deciding whether a piece still fits the line: the model's columns' measured error.
 *
 * Whether a piece fits is decided on a line width that is never short (`NEVER_SHORT`, measured whole), so the only
 * way the model can take a line too few is a column modelled WIDER than Chromium sets it. The columns are shared out
 * as Chromium does, in its 1/64px unit (`packTableLayout.ts`), from widths as Chromium sets them; what is left is
 * Chromium's own float noise, which puts a width at a 1/64px grid point one unit either side of the model's.
 * Measured in `packTableLayout.test.ts` over every statement table, pages 5 to 8, of a stratified sample of packs
 * (1,848 tables), the model's widest column is 1/64px over Chromium's portrait; over a sample set landscape
 * (`packTableLayoutLandscape.test.ts`, long labels at wide figures) it is 3/64px. The guard covers each: 1/32px
 * portrait (1/16 would set a line too many on a balance sheet label that ends a fraction of a pixel inside its column,
 * `NEAR_TIES`), 1/16px landscape (no statement prints landscape today).
 *
 * The error each way: a guard smaller than the columns' worst over-width could fit a piece Chromium wraps, a line too
 * few (the model shorter than the print; both tests fail on any). Larger, more pieces ending near their line take a
 * line too many (the model taller, a page trimmed or refused that would have fitted); the tests count those.
 */
export const WRAP_GUARD: Readonly<Record<PageOrientation, number>> = { portrait: 1 / 32, landscape: 1 / 16 };
/** The portrait guard, the default of a fill with no orientation. */
export const WRAP_GUARD_PX = WRAP_GUARD.portrait;

/**
 * A greedy fill of `parts` into lines of `avail` pixels, each candidate line measured WHOLE by `lineWidth` (Chromium
 * shapes a line as one run: kerning across a space and the rounding of one width, not a sum of rounded pieces), with
 * the hyphen a soft one sets where the candidate would end the line (`Piece.hyphen`); `marker` is a footnote mark that
 * stays with the last part. `lineWidth` must never be short: this decides whether a piece still fits.
 */
export function linesForText(
  parts: readonly Piece[], lineWidth: (text: string, hyphen: boolean) => number, marker: number, avail: number, guardPx: number = WRAP_GUARD_PX,
): number {
  let lines = 1;
  let line = '';
  parts.forEach((part, i) => {
    const mark = i === parts.length - 1 ? marker : 0;
    const candidate = line === '' ? part.text : `${line}${part.spaced ? ' ' : ''}${part.text}`;
    if (line !== '' && lineWidth(candidate, part.hyphen) + mark > avail - guardPx) { lines += 1; line = part.text; } else line = candidate;
  });
  return lines;
}

/** The narrowest `runs` can be set: the widest piece, the footnote mark counted with the LAST one it sits after. */
export function minPx(runs: readonly Run[], marker: number): number {
  return Math.max(0, ...runs.map((run, i) => run.w + (i === runs.length - 1 ? marker : 0)));
}
