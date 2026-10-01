/**
 * HOW WIDE THE PACK'S FACE SETS A FIGURE — FROM THE FACE, NOT FROM A GUESS.
 *
 * zrender measures text on the server from a width table of its own, and for
 * the glyphs a money figure is made of that table is wrong both ways: it
 * charges the non-breaking space `formatMoney` groups thousands with a full
 * em (12px at 12px type, against 2.8 in the face) and a digit 0.56em against
 * 0.6. A gutter sized by it stood nine pixels too wide per separator; a bar
 * tested against it was a pixel narrower per two digits than the figure the
 * browser then drew on it.
 *
 * These are IBM Plex Sans Regular's own advances, read off the `hmtx` table
 * of `public/fonts/IBMPlexSans-Regular.woff2` (1000 units to the em). Every
 * digit is 600 — the face's figures are tabular.
 */
const DIGIT_EM = 0.6;
const ADVANCE_EM: Readonly<Record<string, number>> = {
  '(': 0.335, ')': 0.335, ' ': 0.236, ' ': 0.236, ' ': 0.118, ' ': 0.118,
  '.': 0.272, ',': 0.272, '–': 0.588, '-': 0.399, '<': 0.6, '%': 0.927, "'": 0.242, R: 0.64,
};
/** Anything else: wider than any lowercase letter of the face but `m` and
 *  `w`, so a string this was not written for is over-measured, not under. */
const OTHER_EM = 0.7;

export function packFigureWidthPx(text: string, fontPx: number): number {
  let ems = 0;
  for (const ch of text) ems += ch >= '0' && ch <= '9' ? DIGIT_EM : ADVANCE_EM[ch] ?? OTHER_EM;
  return ems * fontPx;
}
