/**
 * LINE BREAKING OVER EXACT PIXEL WIDTHS: where Chromium may break a label, a reason or a delta line, and how many
 * lines a run of pieces takes in a box of a given width. One splitter for every wrapped text of the fit model: the
 * statement table's labels (`packTableLayout.ts`, and the fit's minimum width in `packFigureFit.ts`) and the KPI
 * tiles' labels, reasons and delta lines (`packKpiLayout.ts`) used to split at slightly different places, and a
 * hyphenated label was refused by one and wrapped by the other.
 *
 * Measured in Chromium (`packLineWrap.test.ts`), which is NOT what UAX 14 reads like:
 *  - a break is allowed at a space, and AFTER every hyphen (also before a digit: "2024-25" breaks after "2024-", and
 *    so does "abc-5", where UAX 14's HY x NU would not), except a hyphen that opens the word and is followed by a
 *    digit ("-5", a sign);
 *  - after an en dash, and before and after an em dash (but not between two em dashes: a run of them is one piece);
 *  - NOT after a slash ("abc/def" is one word, "Fy2024/25" too), a dot, a comma, a colon, an ampersand or a plus.
 */

/** One breakable piece of text: its width, and the gap before it (a space, or none where it follows a hyphen). */
export interface Run { w: number; gap: number }

export interface Piece { text: string; spaced: boolean }

const HYPHEN = '-';
const EN_DASH = '–';
const EM_DASH = '—';

/** The pieces of one word: broken after hyphens and en dashes, and around em dashes. */
function wordPieces(word: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  const chars = [...word];
  chars.forEach((ch, i) => {
    const next = chars[i + 1];
    if (next === undefined) return;
    const afterHyphen = ch === HYPHEN && !(i === 0 && /\d/.test(next));
    const afterDash = ch === EN_DASH || (ch === EM_DASH && next !== EM_DASH);
    const beforeEm = next === EM_DASH && ch !== EM_DASH;
    if (afterHyphen || afterDash || beforeEm) {
      pieces.push(chars.slice(start, i + 1).join(''));
      start = i + 1;
    }
  });
  pieces.push(chars.slice(start).join(''));
  return pieces;
}

/** `text` as its pieces, in order; `spaced` is true for the first piece of every word after the first. */
export function pieces(text: string): Piece[] {
  return text.split(/\s+/).filter((word) => word !== '').flatMap((word, wi) => wordPieces(word)
    .map((piece, pi) => ({ text: piece, spaced: wi > 0 && pi === 0 })));
}

/** The runs of `text`, each `widthOf` wide, a `space` apart where a space separated them. */
export function runsOf(text: string, widthOf: (piece: string) => number, space: number): Run[] {
  return pieces(text).map((piece) => ({ w: widthOf(piece.text), gap: piece.spaced ? space : 0 }));
}

export const totalPx = (runs: readonly Run[]): number => runs.reduce((sum, r) => sum + r.gap + r.w, 0);

/**
 * Slack kept off the box when deciding whether a piece still fits the line: the columns the layout predicts are within
 * 1px of Chromium's and Chromium works in 1/64px, so a piece that fits with less than this to spare may not. The side
 * it errs on is a line too many, which makes the height model taller, never shorter.
 */
export const WRAP_GUARD_PX = 0.5;

/**
 * A greedy fill of `runs` into lines of `avail` pixels; `marker` is a footnote mark that stays with the last run.
 */
export function linesFor(runs: readonly Run[], marker: number, avail: number): number {
  let lines = 1;
  let used = 0;
  runs.forEach((run, i) => {
    const w = run.w + (i === runs.length - 1 ? marker : 0);
    if (i > 0 && used + run.gap + w > avail - WRAP_GUARD_PX) { lines += 1; used = w; } else used += run.gap + w;
  });
  return lines;
}

/** The narrowest `runs` can be set: the widest piece, the footnote mark counted with the LAST one it sits after. */
export function minPx(runs: readonly Run[], marker: number): number {
  return Math.max(0, ...runs.map((run, i) => run.w + (i === runs.length - 1 ? marker : 0)));
}
