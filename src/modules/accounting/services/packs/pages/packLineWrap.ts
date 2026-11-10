/**
 * LINE BREAKING OVER EXACT PIXEL WIDTHS: how many lines a text's pieces take in a box of a given width, each
 * candidate line measured whole, as Chromium shapes it. The statement table's labels and headings
 * (`packTableLayout.ts`) fill with it. Where text may break is `packLineBreaks.ts` (measured in Chromium, which is not
 * UAX 14).
 */
import { fitUnitsPx } from './packGlyphRuler';
import type { Piece } from './packLineBreaks';
import type { PageOrientation } from './packTextMetrics';

export type { Piece } from './packLineBreaks';

/** One breakable piece of text by its width, for the narrowest width (`minPx`). */
export interface Run { w: number }

/**
 * Slack kept off the box when deciding whether a piece still fits the line: the model's columns' measured error.
 *
 * Whether a piece fits is decided as Chromium's line breaker decides it, never short of it (`linesForText`: the line's
 * exact sum and noise margin floored once, `packGlyphRuler.fitUnitsPx`, a heading's mark at its box), so the guard is
 * spent on one thing only: a column modelled WIDER than Chromium sets it. (Before #1235's final review a heading's mark
 * was summed with its words and read a unit short, which took the portrait guard's whole headroom.) The columns are shared out
 * as Chromium does, in its 1/64px unit (`packTableLayout.ts`), from widths as Chromium sets them; what is left is
 * Chromium's own float noise, which puts a width at a 1/64px grid point one unit either side of the model's.
 * Measured in `packTableLayout.test.ts` over every statement table, pages 5 to 8, of a stratified sample of packs
 * (1,848 tables), the model's widest column is 1/64px over Chromium's portrait; over a sample set landscape
 * (`packTableLayoutLandscape.test.ts`, long labels at wide figures) it is 3/64px. The guard covers each: 1/32px
 * portrait (1/16 would set a line too many on a balance sheet label that ends a fraction of a pixel inside its column,
 * `NEAR_TIES`), 1/16px landscape (no statement prints landscape today): a unit of headroom over the measured error each.
 *
 * The error each way: a guard smaller than the columns' worst over-width could fit a piece Chromium wraps, a line too
 * few (the model shorter than the print; both tests fail on any). Larger, more pieces ending near their line take a
 * line too many (the model taller, a page trimmed or refused that would have fitted); the tests count those.
 */
export const WRAP_GUARD: Readonly<Record<PageOrientation, number>> = { portrait: 1 / 32, landscape: 1 / 16 };
/** The portrait guard, the default of a fill with no orientation. */
export const WRAP_GUARD_PX = WRAP_GUARD.portrait;

/**
 * A greedy fill of `parts` into lines of `avail` pixels, each candidate line measured WHOLE by `line.exactPx` (Chromium
 * shapes a line as one run: kerning across a space and the rounding of one width, not a sum of rounded pieces), with
 * the hyphen a soft one sets where the candidate would end the line (`Piece.hyphen`). `line.exactPx` is an EXACT advance
 * sum (unrounded), set at `line.fontPx`: the line is floored once, with Chromium's noise margin for its width and size
 * (`packGlyphRuler.fitUnitsPx`).
 *
 * A footnote mark stays with the last part, and is counted one of two ways. Chromium's line breaker sets each inline
 * item at its own width rounded up to the unit, and lets the last item on the line run up to a unit past the room, so a
 * mark (an item of its own, its `<sup>`) costs its box after the line's words: `markerBoxPx`, a heading's mark
 * (measured: "OTHER INCOME" with mark 1 needs 5822/64px, its words' 5494 and the mark's box 328; the two summed exactly
 * and floored once read 5821, a unit short). `marker` is a mark's EXACT sum, summed with the line before it is floored:
 * a 9pt row label's. The model sets that 8.4px mark at 8.390625px and Chromium at 8.375 (80 digits: 25728/64 against the
 * model's 25776), so its exact sum is over Chromium's by 0.6 of a unit a digit, which covers the box's rounding up; as a
 * box it would read one or two units over, a line too many at a near tie. Both are held never short of Chromium
 * (`packLineFit.test.ts`: headings with their marks, labels with theirs).
 */
export interface LineMeasure { exactPx: (text: string, hyphen: boolean) => number; fontPx: number }

export function linesForText(
  parts: readonly Piece[], line: LineMeasure, marker: number, avail: number, guardPx: number = WRAP_GUARD_PX, markerBoxPx = 0,
): number {
  let lines = 1;
  let text = '';
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    const candidate = text === '' ? part.text : `${text}${part.spaced ? ' ' : ''}${part.text}`;
    // A mark after the last part ends the line there, not at a soft hyphen the part ends with: no hyphen's room.
    const marked = last && (marker > 0 || markerBoxPx > 0);
    const width = fitUnitsPx(line.exactPx(candidate, part.hyphen && !marked) + (last ? marker : 0), line.fontPx) + (last ? markerBoxPx : 0);
    if (text !== '' && width > avail - guardPx) { lines += 1; text = part.text; } else text = candidate;
  });
  return lines;
}

/** The narrowest `runs` can be set: the widest piece, the footnote mark counted with the LAST one it sits after. */
export function minPx(runs: readonly Run[], marker: number): number {
  return Math.max(0, ...runs.map((run, i) => run.w + (i === runs.length - 1 ? marker : 0)));
}
