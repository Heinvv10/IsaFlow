/**
 * WHAT FONTKIT IS GIVEN TO SHAPE, SO IT SETS A RUN AS CHROMIUM (HARFBUZZ) DOES. `packGlyphRuler.ts` measures every run
 * through here.
 *
 * Census of the faces against HarfBuzz (#1235's U+2044 review): the three woff2s carry GSUB aalt, ccmp, dnom, frac,
 * liga, lnum, locl, numr, onum, ordn, salt, sinf, ss01 to ss06, subs, sups, zero and GPOS kern, mark; of HarfBuzz's
 * defaults that is ccmp, locl, liga, kern, mark and the fractions, and fontkit applies the same. Where the two differ
 * is the fractions, and fontkit's glyph cache; both are handled here.
 */
import type * as fontkit from 'fontkit';

/**
 * What Chromium sets as nothing and kerns across ("A\u2060V" is "AV"'s 929/64px at 12px), measured one by one in print
 * Chromium (`packGlyphRuler.test.ts`): the soft hyphen, the zero-width space, the word joiner and the invisible
 * operators (U+2060 to U+2064), the left-to-right mark, embedding, pop and isolates (U+200E, U+202A, U+202C, U+2066,
 * U+2069) and the deprecated format characters U+206A and U+206F. (The model priced the ones the faces lack as a
 * fallback glyph, about 87px each.) Each also breaks a fraction it stands in: HarfBuzz decides a fraction on the text
 * as given, so "1\u00AD\u20442" sets its full-size digits (1626/64 at 12px, not the fraction's 1261).
 */
export const SET_AS_NOTHING = /^[\u00AD\u200B\u200E\u202A\u202C\u2060-\u2064\u2066\u2069\u206A\u206F]$/u;

/**
 * A decimal digit, as HarfBuzz reads one (Unicode's Nd). The faces set none but 0 to 9, and a digit they lack is set
 * from a fallback face and ends the run the ruler shapes, so an ASCII test would decide every run alike.
 */
const isDecimal = (ch: string | undefined): boolean => ch !== undefined && /\p{Nd}/u.test(ch);

/**
 * `text` as the ruler shapes it, read IN THE TEXT AS GIVEN, as HarfBuzz reads it: what Chromium sets as nothing removed,
 * but for a run of it between two digits or beside a fraction slash, which stays one zero-width space (a zero-advance
 * glyph the faces set, and no digit), so fontkit's numerator, denominator or fraction stops there as HarfBuzz's does
 * ("a 11\u00AD1\u204422" is the full-size "11" and a fraction "1\u20442": 2459/64px at 12px/500, not the 2051 of
 * "111\u204422"; "1\u00AD\u20442" makes no fraction); and a line or paragraph separator set as the space Chromium sets it
 * as. No character stands for anything else: a code point a tenant can type means only itself (a private-use one is a
 * fallback glyph, as Chromium sets it).
 */
export function asShaped(text: string): string {
  const chars = Array.from(text);
  let out = '';
  for (let i = 0; i < chars.length;) {
    if (SET_AS_NOTHING.test(chars[i]!)) {
      let end = i;
      while (end < chars.length && SET_AS_NOTHING.test(chars[end]!)) end += 1;
      const before = chars[i - 1];
      const after = chars[end];
      if ((isDecimal(before) && isDecimal(after)) || before === '\u2044' || after === '\u2044') out += '\u200B';
      i = end;
    } else {
      const ch = chars[i]!;
      out += ch === '\u2028' || ch === '\u2029' ? ' ' : ch;
      i += 1;
    }
  }
  return out;
}

/**
 * `run`'s glyphs as fontkit should shape them, each standing for its own code point.
 *  - fontkit keeps ONE glyph object per glyph id, with the code points it was first made for (a substitution makes one
 *    for none: shaping "\u00BD" leaves the fraction slash's glyph standing for nothing), and `glyphsForString` hands that
 *    object back. So every glyph is given its run's code point here, or which of fontkit's rules apply to a run would
 *    depend on what was shaped before it (measured: after "\u00BD", "1\u20442" was no longer a fraction).
 *  - Both shapers apply the faces' fractions around U+2044 by default (numr on the digits before it, dnom on those
 *    after), but HarfBuzz makes a fraction only of a slash with a digit on EACH side, and fontkit of any slash next to a
 *    digit. So a slash without a digit on both sides (in the run, where `asShaped` keeps a zero-width space for what
 *    stood between) stands for no code
 *    point, which leaves its neighbours as they are. Measured: "a \u20441" at 14.67px/500 is 1441/64px in Chromium, and
 *    fontkit's one-sided fraction read 1217/64; "a 1\u20442" is a fraction in both.
 * A run whose glyphs are not one a code point (fontkit folds a variation selector into the glyph before it; the faces
 * set none, so no run the ruler measures holds one) is left to fontkit's own mapping.
 */
export function shapingInput(f: fontkit.Font, run: string): string | fontkit.Glyph[] {
  const glyphs = f.glyphsForString(run);
  const chars = Array.from(run);
  if (glyphs.length !== chars.length) return run;
  const lone = (i: number): boolean => chars[i] === '\u2044' && !(isDecimal(chars[i - 1]) && isDecimal(chars[i + 1]));
  return glyphs.map((g, i) => Object.assign(Object.create(Object.getPrototypeOf(g) as object) as fontkit.Glyph, g, { codePoints: lone(i) ? [] : [chars[i]!.codePointAt(0)!] }));
}
