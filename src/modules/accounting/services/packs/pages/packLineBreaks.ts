/**
 * WHERE CHROMIUM MAY BREAK A LABEL, A REASON OR A DELTA LINE: the one splitter of the fit model.
 *
 * The fit's minimum widths (`packFigureFit.ts`), the statement table's layout and the KPI model all break text into
 * pieces with it; they used to split at slightly different places, and a hyphenated label was refused by one and
 * wrapped by the other. Measured in Chromium (`packLineBreaks.test.ts`), which is NOT what UAX 14 reads like:
 *  - a break is allowed at a collapsible space (space, tab, line feed, carriage return: it hangs, so it adds nothing
 *    to either line). NOT at a no-break space (U+00A0, U+2007, U+202F, U+FEFF), a vertical tab or a form feed, which
 *    hold the word together. After a run of the other space separators (U+1680, U+2000 to U+200A but U+2007, U+2028,
 *    U+2029, U+205F, U+3000), and the run stays on the line it ends: it is part of the piece before the break;
 *  - AFTER every hyphen (also before a digit: "2024-25" breaks after "2024-", and
 *    so does "abc-5", where UAX 14's HY x NU would not), except a hyphen that opens the word and is followed by a
 *    digit ("-5", a sign);
 *  - after an en dash, and before and after an em dash (but not between two: a run of them is one piece);
 *  - between two grapheme clusters that Chromium breaks between (`packBreakRanges.ts`: ideographs, kana, Hangul,
 *    full-width forms, Thai, emoji, currency signs, the degree and plus-minus signs). A cluster is one piece of the
 *    run: a ZWJ family, a skin-toned hand, a flag or a letter with its variation selector never splits. A cluster
 *    meets the cluster BEFORE it as its first code point and the one AFTER it as its last (past the marks, selectors,
 *    skin tones and tags that extend it): a head shaking sideways (U+1F642 ZWJ U+2194 U+FE0F) ends in an arrow,
 *    which holds the letters after it, and nothing breaks after a joiner;
 *  - NOT after a slash, dot, comma, colon, ampersand or plus, and not inside a run of ordinary letters.
 * It errs towards FEWER breaks only where Chromium has none, never more: a piece the model leaves whole that Chromium
 * breaks is a row refused that would have fitted, a piece the model breaks that Chromium keeps would be a row passed
 * that overflows.
 */
import { breaksBetween } from './packBreakRanges';

export interface Piece { text: string; spaced: boolean }

const HYPHEN = '-';
const EN_DASH = '–';
const EM_DASH = '—';

const ZWJ = '\u200D';
/** The space separators Chromium breaks after, keeping them on the line they end (they do not hang). */
const BREAK_AFTER_SPACE = /^[\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]$/u;
/** The white space CSS collapses: the only separators a break consumes. */
const COLLAPSIBLE = /[ \t\n\r]+/;

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

const clustersOf = (word: string): string[] => Array.from(SEGMENTER.segment(word), (part) => part.segment);

/**
 * "Wide": an ideograph, a kana, a Hangul syllable, a full-width form or an emoji. Chromium breaks between one of
 * these and a neighbouring wide cluster, letter or digit, on either side.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0xd7af], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xffef], [0x1b000, 0x1b2ff], [0x20000, 0x323af],
];
const isWide = (code: number): boolean => breaksBetween(code)
  && (WIDE_RANGES.some(([from, to]) => code >= from && code <= to) || /\p{Extended_Pictographic}/u.test(String.fromCodePoint(code)));
/** "Affix": a currency sign, degree, plus-minus, per-mille or minus: it breaks only from another of its kind. */
const isAffix = (code: number): boolean => breaksBetween(code) && !isWide(code);
const isPlain = (code: number): boolean => /[\p{L}\p{N}]/u.test(String.fromCodePoint(code)) && !breaksBetween(code);

/** Extends the code point before it: a mark (variation selectors, the keycap), a skin tone, a tag. */
const EXTENDS = /[\p{M}\p{Emoji_Modifier}\u{E0020}-\u{E007F}]/u;

/** The code point a cluster meets the next one with: its last that is not an extender; null after a joiner. */
function trailingCode(cluster: string): number | null {
  const codes = Array.from(cluster);
  for (let i = codes.length - 1; i >= 0; i -= 1) {
    if (codes[i] === ZWJ) return null;
    if (!EXTENDS.test(codes[i]!)) return codes[i]!.codePointAt(0)!;
  }
  return null;
}

/**
 * Does Chromium break between these two neighbouring clusters? Only where the model is sure: two wide ones, a wide
 * one and a letter or digit, or two affixes. Punctuation, brackets and the signs that cling to a number never take a
 * break the model has not measured (a closing bracket after an ideograph, `$` before one).
 */
const breaksBetweenClusters = (cluster: string, next: string): boolean => {
  const before = trailingCode(cluster);
  if (before === null) return false;
  const after = next.codePointAt(0)!;
  if (isWide(before)) return isWide(after) || isPlain(after);
  if (isWide(after)) return isPlain(before);
  return isAffix(before) && isAffix(after);
};

/** The pieces of one word. */
function wordPieces(word: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  const clusters = clustersOf(word);
  clusters.forEach((cluster, i) => {
    const next = clusters[i + 1];
    if (next === undefined) return;
    const afterHyphen = cluster === HYPHEN && !(i === 0 && /\d/.test(next));
    const afterDash = cluster === EN_DASH || (cluster === EM_DASH && next !== EM_DASH);
    const afterSpace = BREAK_AFTER_SPACE.test(cluster) && !BREAK_AFTER_SPACE.test(next);
    const beforeEm = next === EM_DASH && cluster !== EM_DASH;
    const between = breaksBetweenClusters(cluster, next);
    if (afterHyphen || afterDash || afterSpace || beforeEm || between) {
      pieces.push(clusters.slice(start, i + 1).join(''));
      start = i + 1;
    }
  });
  pieces.push(clusters.slice(start).join(''));
  return pieces;
}

/** `text` as its pieces, in order; `spaced` is true for the first piece of every word after the first. */
export function pieces(text: string): Piece[] {
  return text.split(COLLAPSIBLE).filter((word) => word !== '').flatMap((word, wi) => wordPieces(word)
    .map((piece, pi) => ({ text: piece, spaced: wi > 0 && pi === 0 })));
}
