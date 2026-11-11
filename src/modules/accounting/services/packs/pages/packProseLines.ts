/**
 * HOW MANY LINES A PIECE OF THE PACK'S PROSE TAKES, from the faces' own widths (#1261's prose follow-up).
 *
 * The em table (`packTextMetrics.wrappedLines`, removed) charged a character by its class, an average over the pack's wording:
 * "%" at 0.526em where IBM Plex Sans sets it at 0.96, a run of U+3000 at one 0.26em space, a break at U+2007 and U+FEFF
 * where production has none. This breaks where Chromium does (`packLineBreaks.pieces`) and sets each candidate line at
 * its width as the ruler shapes it (`packFigureWidth.textExactPx`: the face's advances and kerning at the style's size
 * and weight), filling lines as the print does (`packProseFill.proseFill`). The style's size and weight come from
 * `packProseStyles`, held to the CSS.
 *
 * A character the faces do not set is priced from the fallback tables (measured alone in production's image), as the
 * em model priced it: a KNOWN LIMIT, unreached by any fixture. A joined script (Syriac, Arabic, Mongolian) can set a run
 * wider joined than its letters alone (Syriac SADHE 7.52px alone, about 10.3px joined), so a long run of one in prose
 * can read a line short. Pricing every fallback glyph at the widest (7.25em) would be never short, but it cut the
 * dense pack's Japanese matters from 12 to 5 of 15 (#1261 round 2), so the tables stay. A run of a script Chromium
 * breaks by dictionary (Thai, Lao, Myanmar, Khmer) is one piece here and is filled grapheme by grapheme; the markup sets
 * it to break anywhere so Chromium does too (`packDictionaryBreak`), and a spacing mark costs its own advance
 * (`packFallbackWidthCore`).
 * Server-only: the ruler reads the faces.
 */
import { textExactPx } from './packFigureWidth';
import { FALLBACK } from './packFallbackWidthData';
import { graphemes } from './packGraphemes';
import { KEPT_CHARS, PROSE_TEXT_CAP, proseFill, SHAPED_CLUSTER, type ProseSegment } from './packProseFill';
import type { ProseStyle, ProseWeight } from './packProseStyles';

export { PROSE_GUARD_PX, type ProseSegment } from './packProseFill';

/**
 * The ruler's widths, kept across calls: a pack sets the same words and joins on every page and every fit attempt. Only
 * short texts are kept (as `packProseBound` keeps its bounds): tenant text is as long as a tenant makes it.
 */
const WIDTHS = new Map<string, number>();
const WIDTHS_KEPT = 200_000;

/** The longest text the widths are kept for (what `packProseFillLinear.test.ts` holds under KEPT_CHARS). */
export function keptWidthLongest(): number {
  let longest = 0;
  for (const key of WIDTHS.keys()) longest = Math.max(longest, key.length - key.split('|', 3).join('|').length - 1);
  return longest;
}

const FALLBACK_STYLE = { 400: 'label400', 500: 'label500', 600: 'label600' } as const;
const FALLBACK_MEASURED_PX = 12;

/** `textExactPx`, with each cluster longer than SHAPED_CLUSTER charged at the widest fallback glyph a code point. */
function rulerPx(text: string, px: number, weight: ProseWeight, hyphen: boolean): number {
  if (text.length <= SHAPED_CLUSTER) return textExactPx(text, px, weight, hyphen, true);
  let shaped = '';
  let long = 0;
  for (const { segment } of graphemes(text)) {
    if (segment.length > SHAPED_CLUSTER) long += Array.from(segment).length; else shaped += segment;
  }
  if (long === 0) return textExactPx(text, px, weight, hyphen, true);
  return textExactPx(shaped, px, weight, hyphen, true) + (long * FALLBACK[FALLBACK_STYLE[weight]].widest * px) / FALLBACK_MEASURED_PX;
}

function exactPx(text: string, px: number, weight: ProseWeight, hyphen: boolean): number {
  if (text.length > KEPT_CHARS) return rulerPx(text, px, weight, hyphen);
  const key = `${weight}|${px}|${hyphen ? 1 : 0}|${text}`;
  let width = WIDTHS.get(key);
  if (width === undefined) {
    if (WIDTHS.size >= WIDTHS_KEPT) WIDTHS.clear();
    width = rulerPx(text, px, weight, hyphen);
    WIDTHS.set(key, width);
  }
  return width;
}

/**
 * The lines of the last few LONG texts, kept: a fit tries a page again and again, and a long tenant text (a journal's
 * description) is measured anew each time. Bounded in entries, and only a text within `PROSE_TEXT_CAP` is kept (one past
 * it is not measured at all), so in bytes too: at most LONG_KEPT x PROSE_TEXT_CAP characters.
 */
const LONG_LINES = new Map<string, number>();
const LONG_KEPT = 32;
const LONG_TEXT = 1_000;

/** How many long texts' lines are kept (`packProseLongText.test.ts`). */
export const keptLongLines = (): number => LONG_LINES.size;

/** The lines `text` (or its segments) takes set in `style`, `widthMm` wide. */
export function proseLines(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  if (typeof text !== 'string' || text.length <= LONG_TEXT || text.length > PROSE_TEXT_CAP) return proseFill(text, style, widthMm, exactPx);
  const key = `${style.pt}|${style.weight}|${widthMm}|${text}`;
  let lines = LONG_LINES.get(key);
  if (lines === undefined) {
    lines = proseFill(text, style, widthMm, exactPx);
    if (LONG_LINES.size >= LONG_KEPT) LONG_LINES.delete(LONG_LINES.keys().next().value!);
    LONG_LINES.set(key, lines);
  }
  return lines;
}
