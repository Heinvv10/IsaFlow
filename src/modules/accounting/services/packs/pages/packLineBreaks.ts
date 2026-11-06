/**
 * WHERE CHROMIUM MAY BREAK A LABEL, A REASON OR A DELTA LINE: the one splitter of the fit model.
 *
 * The fit's minimum widths (`packFigureFit.ts`), the statement table's layout and the KPI model all break text into
 * pieces with it; they used to split at slightly different places, and a hyphenated label was refused by one and
 * wrapped by the other. Measured in Chromium (`packLineBreaks.test.ts`), which is NOT what UAX 14 reads like:
 *  - a break is allowed at a space, and AFTER every hyphen (also before a digit: "2024-25" breaks after "2024-", and
 *    so does "abc-5", where UAX 14's HY x NU would not), except a hyphen that opens the word and is followed by a
 *    digit ("-5", a sign);
 *  - after an en dash, and before and after an em dash (but not between two: a run of them is one piece);
 *  - between two grapheme clusters that Chromium breaks between (`packBreakRanges.ts`: ideographs, kana, Hangul,
 *    full-width forms, Thai, emoji, currency signs, the degree and plus-minus signs). A cluster is one piece of the
 *    run: a ZWJ family, a skin-toned hand, a flag or a letter with its variation selector never splits;
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

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

const clustersOf = (word: string): string[] => Array.from(SEGMENTER.segment(word), (part) => part.segment);

/**
 * "Wide": an ideograph, a kana, a Hangul syllable, a full-width form or an emoji. Chromium breaks between one of
 * these and a neighbouring wide cluster, letter or digit, on either side.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2e80, 0xd7af], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xffef], [0x1b000, 0x1b2ff], [0x20000, 0x323af],
];
const isWide = (cluster: string): boolean => {
  const code = cluster.codePointAt(0)!;
  if (!breaksBetween(code)) return false;
  return WIDE_RANGES.some(([from, to]) => code >= from && code <= to) || /\p{Extended_Pictographic}/u.test(cluster);
};
/** "Affix": a currency sign, degree, plus-minus, per-mille or minus: it breaks only from another of its kind. */
const isAffix = (cluster: string): boolean => breaksBetween(cluster.codePointAt(0)!) && !isWide(cluster);
const isPlain = (cluster: string): boolean => /^[\p{L}\p{N}]/u.test(cluster) && !breaksBetween(cluster.codePointAt(0)!);

/**
 * Does Chromium break between these two neighbouring clusters? Only where the model is sure: two wide ones, a wide
 * one and a letter or digit, or two affixes. Punctuation, brackets and the signs that cling to a number never take a
 * break the model has not measured (a closing bracket after an ideograph, `$` before one).
 */
const breaksBetweenClusters = (cluster: string, next: string): boolean => {
  if (isWide(cluster)) return isWide(next) || isPlain(next);
  if (isWide(next)) return isPlain(cluster);
  return isAffix(cluster) && isAffix(next);
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
    const beforeEm = next === EM_DASH && cluster !== EM_DASH;
    const between = breaksBetweenClusters(cluster, next);
    if (afterHyphen || afterDash || beforeEm || between) {
      pieces.push(clusters.slice(start, i + 1).join(''));
      start = i + 1;
    }
  });
  pieces.push(clusters.slice(start).join(''));
  return pieces;
}

/** `text` as its pieces, in order; `spaced` is true for the first piece of every word after the first. */
export function pieces(text: string): Piece[] {
  return text.split(/\s+/).filter((word) => word !== '').flatMap((word, wi) => wordPieces(word)
    .map((piece, pi) => ({ text: piece, spaced: wi > 0 && pi === 0 })));
}
