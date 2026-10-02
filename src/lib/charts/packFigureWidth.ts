/**
 * HOW WIDE THE PACK'S FACE SETS A LINE OF CHART TEXT — FROM THE FACE, NOT
 * FROM A GUESS.
 *
 * zrender measures text on the server from a width table of its own, and for
 * the glyphs a money figure is made of that table is wrong both ways: it
 * charges the non-breaking space `formatMoney` groups thousands with a full
 * em (12px at 12px type, against 2.8 in the face) and a digit 0.56em against
 * 0.6. A gutter sized by it stood nine pixels too wide per separator; a bar
 * tested against it was a pixel narrower per two digits than the figure the
 * browser then drew on it. On words it is closer and still up to three
 * pixels short on a category name.
 *
 * These are IBM Plex Sans Regular's own advances, read off the `hmtx` table
 * of `public/fonts/IBMPlexSans-Regular.woff2`, in thousandths of an em:
 * every printable ASCII character from the space to the tilde, and the few
 * beyond it a chart prints. Every digit is 600 — the face's figures are
 * tabular. No kerning: the face kerns a few capital pairs by a fraction of a
 * pixel at chart sizes, and every consumer keeps a pixel or two of slack.
 */
const ASCII_FIRST = 0x20;
const ASCII_ADVANCE = [
  236, 284, 419, 713, 598, 927, 694, 242, 335, 335, 450, 600, 272, 399, 272, 383,
  600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 292, 292, 600, 600, 600, 477,
  891, 641, 653, 621, 671, 583, 559, 695, 707, 400, 510, 634, 501, 812, 707, 708,
  606, 708, 640, 581, 572, 678, 609, 891, 613, 593, 580, 317, 383, 317, 600, 565,
  600, 534, 580, 503, 580, 549, 324, 528, 568, 250, 250, 527, 272, 873, 568, 560,
  580, 580, 367, 487, 351, 568, 492, 768, 507, 499, 464, 343, 314, 343, 600,
] as const;
const OTHER_ADVANCE: Readonly<Record<string, number>> = {
  '\u00a0': 236, '\u202f': 118, '\u2009': 118, '\u2013': 588, '\u2014': 780, '\u2019': 273,
};
/** Anything else: wider than any lowercase letter of the face but `m` and
 *  `w`, so a string this was not written for is over-measured, not under. */
const UNKNOWN_ADVANCE = 700;

/** How wide `text` is set at `fontPx`. A figure, a tick, a category name. */
export function packFigureWidthPx(text: string, fontPx: number): number {
  let units = 0;
  for (const ch of text) units += ASCII_ADVANCE[ch.charCodeAt(0) - ASCII_FIRST] ?? OTHER_ADVANCE[ch] ?? UNKNOWN_ADVANCE;
  return (units / 1000) * fontPx;
}
