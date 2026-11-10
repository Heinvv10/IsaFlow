/**
 * THE LINE FILL THE PAGE MODEL'S PROSE IS MEASURED BY, with the width of a run left to the caller: the server's model
 * (`packProseLines.proseLines`) gives the ruler's shaped width, and the commentary gate in the browser
 * (`packProseBound.proseLinesBound`) an upper bound from a per-code-point table. One fill for both, so the gate's lines
 * are the page's whenever its widths are at or over the page's (a greedy fill never sets fewer lines for wider pieces).
 *
 * It breaks where Chromium does, by the splitter the row labels are fitted by (`packLineBreaks.pieces`: collapsible
 * space, the pair table scanned in production's image for the faces' characters, the ranges for the rest, soft hyphens
 * and zero-width spaces), and keeps each piece whole: a hyphenated file name or a link breaks after a hyphen or a
 * slash, and a line ends short of the measure by what the next piece needed (#1263 round 1 H1: charging such a token as
 * continuous fill read page 11 a sheet short, and a CJK run, which breaks between its ideographs, a line or two short:
 * #1263 round 1). A line is measured as Chromium shapes it, each piece against the one before it (kerning across a space
 * or a hyphen), with the hyphen a soft hyphen sets where the line would end there (`Piece.hyphen`); a collapsible space
 * hangs at a line's end. Only a piece with no break opportunity inside it that is wider than the measure on its own is
 * filled grapheme by grapheme, from a new line, each line as full as whole graphemes make it: no breaking of it takes
 * fewer lines (`overflow-wrap: anywhere`), and where nothing breaks it (`normal`) it overflows one line and the next
 * piece starts below: fewer lines than the fill charges. A line holds what fits in the measure less `PROSE_GUARD_PX` (Chromium's
 * layout units and its float noise; `printParity/packProseLinesImage.test.ts` prints at the model's own boundary).
 * Client-safe: it reads no face.
 */
import { pieces } from './packLineBreaks';
import type { ProseStyle, ProseWeight } from './packProseStyles';

export const PROSE_GUARD_PX = 0.5;

const MM_PX = 96 / 25.4;
const COLLAPSIBLE = /[ \t\n\r]/;
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A piece of prose in one weight (a note's heading and its body are two). */
export interface ProseSegment { readonly text: string; readonly weight: ProseWeight }

/** The width of `text` set at `px` in `weight`, and a soft hyphen's hyphen after it where `hyphen` (called again and
 *  again for the same short texts: the caller keeps what it measured). */
export type ProseWidth = (text: string, px: number, weight: ProseWeight, hyphen: boolean) => number;

/** A stretch of a line in one weight. */
interface Run { text: string; weight: ProseWeight }

/** `runs` with `text` (in `weights`, one per code unit) appended, a run per weight. */
function appended(runs: readonly Run[], text: string, weights: readonly ProseWeight[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  Array.from(text).reduce((at, ch) => {
    const weight = weights[at]!;
    const last = out[out.length - 1];
    if (last !== undefined && last.weight === weight) last.text += ch; else out.push({ text: ch, weight });
    return at + ch.length;
  }, 0);
  return out;
}

/** `a` then `b`, a run where the weight meets itself: one run is shaped as one, across the join. */
function joined(a: readonly Run[], b: readonly Run[]): Run[] {
  const out = a.map((r) => ({ ...r }));
  for (const run of b) {
    const last = out[out.length - 1];
    if (last !== undefined && last.weight === run.weight) last.text += run.text; else out.push({ ...run });
  }
  return out;
}

/** The lines `text` (or its segments) takes set in `style`, `widthMm` wide, each run `widthOf` wide. */
export function proseFill(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number, widthOf: ProseWidth): number {
  const segments = typeof text === 'string' ? [{ text, weight: style.weight }] : text;
  const full = segments.map((s) => s.text).join('');
  const weights = segments.flatMap((s) => Array.from({ length: s.text.length }, () => s.weight));
  const px = (style.pt * 96) / 72;
  const avail = widthMm * MM_PX - PROSE_GUARD_PX;
  const widthPx = (runs: readonly Run[], hyphen: boolean): number =>
    runs.reduce((sum, run, i) => sum + widthOf(run.text, px, run.weight, hyphen && i === runs.length - 1), 0);

  // The line so far: its width (no hyphen), and the last unit set on it, which the next is shaped against (a line is
  // measured as Chromium shapes it, across the joins, without remeasuring all of it each time).
  let lines = 1;
  let lineWidth = 0;
  let tail: Run[] = [];
  /** The line's width with `unit` set after it, and a soft hyphen's hyphen where `hyphen`. */
  const withUnit = (unit: readonly Run[], hyphen: boolean): number => (tail.length === 0
    ? widthPx(unit, hyphen) : lineWidth + widthPx(joined(tail, unit), hyphen) - widthPx(tail, false));
  const set = (unit: Run[]): void => { lineWidth = withUnit(unit, false); tail = unit; };
  const startLine = (): void => { lines += 1; lineWidth = 0; tail = []; };

  let at = 0;
  for (const piece of pieces(full)) {
    while (COLLAPSIBLE.test(full[at] ?? '')) at += 1;
    if (full.slice(at, at + piece.text.length) !== piece.text) throw new Error(`proseFill: piece "${piece.text}" is not the text at ${at}`);
    const own = weights.slice(at, at + piece.text.length);
    const bare = appended([], piece.text, own);
    const spaced = piece.spaced && tail.length > 0 ? appended([], ` ${piece.text}`, [weights[at - 1] ?? own[0]!, ...own]) : bare;
    at += piece.text.length;
    if (withUnit(spaced, piece.hyphen) <= avail) { set(spaced); continue; }
    if (tail.length > 0) startLine();
    if (widthPx(bare, piece.hyphen) <= avail) { set(bare); continue; }
    // Wider than the measure on its own: grapheme by grapheme, each line as full as it can be.
    let offset = 0;
    for (const { segment } of SEGMENTER.segment(piece.text)) {
      const unit = appended([], segment, own.slice(offset));
      offset += segment.length;
      if (tail.length > 0 && withUnit(unit, false) > avail) startLine();
      set(unit);
    }
    // Its last line ends at its soft hyphen where nothing follows on it: the hyphen's room too.
    if (piece.hyphen && withUnit([], true) > avail) startLine();
  }
  return lines;
}
