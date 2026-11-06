/**
 * GREEDY LINE FILLING OVER EXACT PIXEL WIDTHS: how many lines a run of words takes in a box of a given width, as
 * Chromium breaks them (at spaces, and after a hyphen). Shared by the statement table's labels and headings
 * (`packTableLayout.ts`) and the KPI tiles' labels, reasons and delta lines (`packKpiLayout.ts`).
 */

/** One breakable piece of text: its width, and the gap before it where it does not follow a hyphen. */
export interface Run { w: number; gap: number }

export const totalPx = (runs: readonly Run[]): number => runs.reduce((sum, r) => sum + r.gap + r.w, 0);

/** The runs of `text` a line may break between: words a `space` apart, and hyphen pieces touching. */
export function runsOf(text: string, widthOf: (run: string) => number, space: number): Run[] {
  return text.split(/\s+/).filter((word) => word !== '').flatMap((word, wi) => word.split(/(?<=-)/)
    .map((run, ri) => ({ w: widthOf(run), gap: wi > 0 && ri === 0 ? space : 0 })));
}

/** A greedy fill of `runs` into lines of `avail`; `marker` is a footnote mark that stays with the last run. */
export function linesFor(runs: readonly Run[], marker: number, avail: number): number {
  let lines = 1;
  let used = 0;
  runs.forEach((run, i) => {
    const w = run.w + (i === runs.length - 1 ? marker : 0);
    if (i > 0 && used + run.gap + w > avail + 0.01) { lines += 1; used = w; } else used += run.gap + w;
  });
  return lines;
}
