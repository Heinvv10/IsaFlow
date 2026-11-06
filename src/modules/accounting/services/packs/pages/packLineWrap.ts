/**
 * LINE BREAKING OVER EXACT PIXEL WIDTHS: where Chromium may break a label, a reason or a delta line, and how many
 * lines a run of pieces takes in a box of a given width. One splitter for every wrapped text of the fit model: the
 * statement table's labels (`packTableLayout.ts`, and the fit's minimum width in `packFigureFit.ts`) and the KPI
 * tiles' labels, reasons and delta lines (`packKpiLayout.ts`) used to split at slightly different places, and a
 * hyphenated label was refused by one and wrapped by the other.
 *
 * Where text may break is `packLineBreaks.ts` (measured in Chromium, which is not UAX 14).
 */

import { pieces } from './packLineBreaks';

/** One breakable piece of text: its width, and the gap before it (a space, or none where it follows a hyphen). */
export interface Run { w: number; gap: number }

export type { Piece } from './packLineBreaks';

/** The runs of `text`, each `widthOf` wide, a `space` apart where a space separated them. */
export function runsOf(text: string, widthOf: (piece: string) => number, space: number): Run[] {
  return pieces(text).map((piece) => ({ w: widthOf(piece.text), gap: piece.spaced ? space : 0 }));
}

export const totalPx = (runs: readonly Run[]): number => runs.reduce((sum, r) => sum + r.gap + r.w, 0);

/**
 * Slack kept off the box when deciding whether a piece still fits the line. It is a TIE-BREAK, not a bound on the
 * layout's error: the columns `packTableLayout.ts` predicts are within 0.93px of Chromium's, far more than this, and a
 * piece that ends inside that error is decided by the measurements below, not by the guard.
 *
 * Measured over every caller of the fill (`packTableLayout.ts`: the row labels and the column headings of every
 * statement table, pages 5 to 8) in `packTableLayout.test.ts`: every table of its stratified sample of packs sets the
 * same lines as Chromium with any guard from -0.2 to 0.12px (1,872 tables with the adversary's k=30,000 packs). Only
 * page 6 bounds that range (the adversary's label 0.1px inside its column wraps from 0.15px; at -0.5 a label is a line
 * short). Off page 6, the balance sheet's and the cash table's near ties (labels ending 0.16 to 0.42px inside their
 * column) set Chromium's lines at 0.1 and a line too many at 0.5.
 *
 * The error each way: a guard too large sets a line too many where a piece ends within it of its line (the model is
 * taller than the print, and a page is trimmed or refused that would have fitted: 0.5 did this to six packs); too
 * small, or a column modelled wider than Chromium's by more than the piece has to spare, sets a line too few (the model
 * is shorter, and the sheet runs past its foot). `packTableLayout.test.ts` holds the height never short over its sample.
 */
export const WRAP_GUARD_PX = 0.1;

/**
 * A greedy fill of `runs` into lines of `avail` pixels; `marker` is a footnote mark that stays with the last run.
 */
export function linesFor(runs: readonly Run[], marker: number, avail: number, guardPx: number = WRAP_GUARD_PX): number {
  let lines = 1;
  let used = 0;
  runs.forEach((run, i) => {
    const w = run.w + (i === runs.length - 1 ? marker : 0);
    if (i > 0 && used + run.gap + w > avail - guardPx) { lines += 1; used = w; } else used += run.gap + w;
  });
  return lines;
}

/** The narrowest `runs` can be set: the widest piece, the footnote mark counted with the LAST one it sits after. */
export function minPx(runs: readonly Run[], marker: number): number {
  return Math.max(0, ...runs.map((run, i) => run.w + (i === runs.length - 1 ? marker : 0)));
}
