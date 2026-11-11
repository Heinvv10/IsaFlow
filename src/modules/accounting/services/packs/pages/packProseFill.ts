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
import { graphemes } from './packGraphemes';
import { pieces } from './packLineBreaks';
import type { ProseStyle, ProseWeight } from './packProseStyles';

export const PROSE_GUARD_PX = 0.5;

/** The longest text a width function keeps the width of across calls (`packProseLines`, `packProseBound`): the fill asks
 *  for pieces, graphemes and joins, short texts; a longer one is tenant text of any length, measured and not kept. */
export const KEPT_CHARS = 64;

/**
 * Prose longer than this is not measured: it is charged PAST_ANY_PAGE lines (more than any page holds, some 70; not a
 * measure of the text, which can be longer still), so the page drops it or refuses at once
 * (#1263 round 2: a journal description of 200,000 characters held the composer for minutes). A page holds under
 * 20,000 characters even of the narrowest letter ("i i i", 7.5pt across 174mm: about 290 a line, 65 lines), so past the
 * cap only a text made mostly of characters that print nothing could fit, and it is charged as not fitting. Below the
 * cap nothing changes.
 */
export const PROSE_TEXT_CAP = 50_000;
export const PAST_ANY_PAGE = 10_000;

/**
 * Prose holding more default-ignorable code points than this (zero-width spaces and joiners, ZWNBSP, bidi and invisible
 * operators, selectors, the soft hyphen) is charged PAST_ANY_PAGE lines too: they print nothing, so a page made of them
 * fits, and measuring 50,000 of them in each of a pack's matters held the composer for seconds (#1263 round 3). The
 * commentary cap is 4,000 characters; no prose a tenant writes holds this many characters that print nothing.
 */
export const IGNORABLE_CAP = 4_000;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * A cluster of more code units than this is not shaped (the ruler's shaping of one cluster of many marks takes time
 * that grows with its square: "e" and 40,000 acute accents took 2.4s): the page model (`packProseLines`) and the gate
 * (`packProseBound`) both charge it the widest fallback glyph for each of its code points, which no setting exceeds.
 */
export const SHAPED_CLUSTER = 32;

const MM_PX = 96 / 25.4;
const COLLAPSIBLE = /[ \t\n\r]/;

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
  if (full.length > PROSE_TEXT_CAP) return PAST_ANY_PAGE;
  if (full.length > IGNORABLE_CAP && (full.match(IGNORABLE)?.length ?? 0) > IGNORABLE_CAP) return PAST_ANY_PAGE;
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
  for (const piece of pieces(full, { dictionarySpans: true })) {
    while (COLLAPSIBLE.test(full[at] ?? '')) at += 1;
    if (full.slice(at, at + piece.text.length) !== piece.text) throw new Error(`proseFill: piece "${piece.text}" is not the text at ${at}`);
    const own = weights.slice(at, at + piece.text.length);
    const spacedAt = weights[at - 1] ?? own[0]!;
    at += piece.text.length;
    const bare = appended([], piece.text, own);
    const spaced = piece.spaced && tail.length > 0 ? appended([], ` ${piece.text}`, [spacedAt, ...own]) : bare;
    if (withUnit(spaced, piece.hyphen) <= avail) { set(spaced); continue; }
    if (tail.length > 0) startLine();
    if (widthPx(bare, piece.hyphen) <= avail) { set(bare); continue; }
    // Wider than the measure on its own: grapheme by grapheme, each line as full as it can be. Each grapheme is one run
    // in the weight it starts in (no copy of what is left of the piece: the work stays linear in its length).
    let last: Run[] = [];
    for (const { segment, index } of graphemes(piece.text)) {
      last = [{ text: segment, weight: own[index]! }];
      if (tail.length > 0 && withUnit(last, false) > avail) startLine();
      set(last);
      // One cluster wider than the line: the print can break even inside it (a run of repeated marks, in a
      // dictionary-script span), so it is charged the lines its width fills.
      if (lineWidth > avail) lines += Math.ceil(lineWidth / avail) - 1;
    }
    // A line that ends at its soft hyphen needs the hyphen's room. Where it has none, Chromium carries the piece's last
    // grapheme down to a line of its own with the hyphen (#1263 round 2: the line left empty here read a line short).
    if (piece.hyphen && withUnit([], true) > avail) { startLine(); set(last); }
  }
  return lines;
}
