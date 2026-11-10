/**
 * HOW MANY LINES A PIECE OF THE PACK'S PROSE TAKES, from the faces' own widths (#1261's prose follow-up).
 *
 * The em table (`packTextMetrics.wrappedLines`) charged a character by its class, an average over the pack's wording:
 * "%" at 0.526em where IBM Plex Sans sets it at 0.96, a run of U+3000 at one 0.26em space, a break at U+2007 and U+FEFF
 * where production has none. This sets each word at its width as the ruler shapes it (`packFigureWidth.textExactPx`:
 * the face's advances and kerning at the style's size and weight, a character the faces lack priced from the fallback
 * tables), and fills lines as the print does:
 *  - a run of collapsible white space (space, tab, newline) is one space, a break after it, and it hangs at a line's end;
 *  - a run of the other spaces (U+1680, U+2000-2006, U+2008-200A, U+205F, U+3000) is set, each at its width, and a
 *    break after the run only (no break between two of them), and it does not hang;
 *  - a no-break space (U+00A0, U+202F, U+2007), ZWNBSP and the word joiner are part of the word;
 *  - a word wider than the measure is charged the lines it fills (the print breaks it, or it overflows on one line:
 *    never fewer lines either way).
 * A line holds what fits in the measure less `PROSE_GUARD_PX` (Chromium's layout units and its float noise).
 * Server-only: the ruler reads the faces. The style's size and weight come from `packProseStyles`, held to the CSS.
 */
import { textExactPx } from './packFigureWidth';
import type { ProseStyle, ProseWeight } from './packProseStyles';

export const PROSE_GUARD_PX = 0.5;

const MM_PX = 96 / 25.4;
/** Space characters CSS does not collapse: set at their width, a break after a run of them. */
const SET_SPACE = /[  -  -  　]/u;

/** A piece of prose in one weight (a note's heading and its body are two). */
export interface ProseSegment { readonly text: string; readonly weight: ProseWeight }

interface Token { width: number; space: number }

/** The words of `segments` with the width of each, and of the collapsible space after it, at `px`. */
function tokens(segments: readonly ProseSegment[], px: number): Token[] {
  const out: Token[] = [];
  // The word being read, as runs of one weight (a word can change weight where a heading meets its text).
  let parts: Array<{ text: string; weight: ProseWeight }> = [];
  const wordPx = (): number => parts.reduce((sum, part) => sum + textExactPx(part.text, px, part.weight), 0);
  const end = (space: number): void => {
    if (parts.length > 0) { out.push({ width: wordPx(), space }); parts = []; return; }
    const last = out[out.length - 1];
    if (last !== undefined) last.space = Math.max(last.space, space);
  };
  const chars = segments.flatMap(({ text, weight }) => Array.from(text, (ch) => ({ ch, weight })));
  chars.forEach(({ ch, weight }, i) => {
    if (/[ \t\n\r]/.test(ch)) { end(textExactPx(' ', px, weight)); return; }
    const last = parts[parts.length - 1];
    if (last !== undefined && last.weight === weight) last.text += ch; else parts.push({ text: ch, weight });
    // A run of set spaces ends the word after its last one.
    if (SET_SPACE.test(ch) && !SET_SPACE.test(chars[i + 1]?.ch ?? '')) end(0);
  });
  end(0);
  return out;
}

/** The lines `text` (or its segments) takes set in `style`, `widthMm` wide. */
export function proseLines(text: string | readonly ProseSegment[], style: ProseStyle, widthMm: number): number {
  const segments = typeof text === 'string' ? [{ text, weight: style.weight }] : text;
  const px = (style.pt * 96) / 72;
  const avail = widthMm * MM_PX - PROSE_GUARD_PX;
  let lines = 1;
  let used = 0;
  let trailing = 0;
  for (const { width, space } of tokens(segments, px)) {
    if (used > 0 && used + trailing + width > avail) { lines += 1; used = 0; trailing = 0; }
    let rest = used === 0 ? width : used + trailing + width;
    while (rest > avail) { lines += 1; rest -= avail; }
    used = rest;
    trailing = space;
  }
  return lines;
}
