/**
 * THE WIDTH OF A KPI TILE'S NOT-MEANINGFUL REASON, IN DEVICE PIXELS, AS CHROMIUM LAYS IT OUT.
 *
 * `.pack-kpi-unavailable` is 11pt (14.667px) italic, and the pack's italic cut of IBM Plex Sans is a real face with
 * its own advances ("nnnnnnnnnnnnnnnnnnnn" is 160px in it and 180px in the regular face the figure ruler uses at
 * 15px). Each glyph's advance is a whole number of pixels at this one size, measured between two bars through the
 * class itself; `packFigureWidth.test.ts` re-measures every entry and fails if one drifts.
 *
 * It covers Basic Latin, Latin-1 and Latin Extended-A (the accented letters a company's own names and reasons use,
 * U+0020 to U+017F) and the typographic punctuation and symbols a sentence carries (quotes, dashes, the ellipsis, the
 * multiplication sign, currency): 335 glyphs. A glyph outside them is charged the widest measured, 15px: an upper
 * bound that is not the 14px a typical glyph measures at 6 to 9.
 */
// U+0020 to U+017F in order; U+007F to U+009F are controls and not set (0).
const LATIN: readonly number[] = [
  3, 4, 6, 10, 9, 14, 10, 4, 5, 5, 7, 9, 4, 6, 4, 6,
  9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 4, 4, 9, 9, 9, 7,
  13, 9, 10, 9, 10, 9, 8, 10, 10, 6, 7, 9, 7, 12, 10, 10,
  9, 10, 9, 9, 8, 10, 9, 13, 9, 9, 9, 5, 6, 5, 9, 8,
  9, 8, 9, 7, 9, 8, 5, 8, 8, 4, 4, 8, 4, 13, 8, 8,
  9, 9, 5, 7, 5, 8, 7, 11, 7, 7, 7, 5, 5, 5, 9, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  3, 4, 8, 9, 9, 9, 5, 9, 9, 11, 6, 8, 9, 0, 7, 9,
  7, 9, 5, 5, 9, 8, 10, 5, 9, 5, 6, 8, 12, 13, 12, 7,
  9, 9, 9, 9, 9, 9, 13, 9, 9, 9, 9, 9, 6, 6, 6, 6,
  10, 10, 10, 10, 10, 10, 10, 9, 10, 10, 10, 10, 10, 9, 9, 9,
  8, 8, 8, 8, 8, 8, 13, 7, 8, 8, 8, 8, 4, 4, 4, 4,
  8, 8, 8, 8, 8, 8, 8, 9, 8, 8, 8, 8, 8, 7, 9, 7,
  9, 8, 9, 8, 9, 8, 9, 7, 9, 7, 9, 7, 9, 7, 10, 9,
  10, 9, 9, 8, 9, 8, 9, 8, 9, 8, 9, 8, 10, 8, 10, 8,
  10, 8, 10, 8, 10, 8, 10, 8, 6, 4, 6, 4, 6, 4, 6, 4,
  6, 4, 9, 7, 7, 4, 9, 8, 8, 7, 4, 7, 4, 7, 4, 7,
  5, 7, 4, 10, 8, 10, 8, 10, 8, 12, 10, 8, 10, 8, 10, 8,
  10, 8, 14, 14, 9, 5, 9, 5, 9, 5, 9, 7, 9, 7, 9, 7,
  9, 7, 8, 5, 8, 5, 9, 5, 10, 8, 10, 8, 10, 8, 10, 8,
  10, 8, 10, 8, 13, 11, 9, 7, 9, 9, 7, 9, 7, 9, 7, 4,
];
const OTHER: Readonly<Record<string, number>> = {
  '\u2018': 4,
  '\u2019': 4,
  '\u201c': 7,
  '\u201d': 7,
  '\u2013': 9,
  '\u2014': 11,
  '\u2026': 12,
  '\u2022': 6,
  '\u20ac': 9,
  '\u2212': 9,
  '\u2010': 6,
  '\u2011': 6,
  '\u2012': 9,
  '\u2015': 15,
  '\u2032': 4,
  '\u2033': 6,
};
const WIDEST_PX = 15;

function advance(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x17f) return LATIN[code - 0x20] || WIDEST_PX;
  return OTHER[ch] ?? WIDEST_PX;
}

export function reasonPx(text: string): number {
  let px = 0;
  for (const ch of text) px += advance(ch);
  return px;
}
