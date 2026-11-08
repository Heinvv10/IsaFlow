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
 *  - after a hyphen or an en dash, and before and after an em dash, where the dash stands between two WORD clusters (a
 *    letter or digit of an alphabetic script, with its marks): "2024-25" breaks after "2024-", and so does "abc-5",
 *    where UAX 14's HY x NU would not; "a–b" after the dash, "abc—def" on both sides of it; after a word, a hyphen
 *    also breaks before another hyphen or an em dash ("abc-|-def", "ab-|—cd"), and one that opens the word or follows
 *    another breaks before a letter ("-|abc", "abc-|-|def"; "-5" is a sign and holds). Not next to punctuation, a
 *    bracket, a quote, a sign, a symbol, a space of any kind, a joiner, an ideograph, another dash or an emoji
 *    (".-", ")–", "$-", "-⁠", "––", "(—", "々-" are one piece in Chromium), and not after a dash that opens the word;
 *  - between two grapheme clusters that Chromium breaks between (`packBreakRanges.ts`: ideographs, kana, Hangul,
 *    full-width forms, Thai, emoji, currency signs, the degree and plus-minus signs). A cluster is one piece of the
 *    run: a ZWJ family, a skin-toned hand, a flag or a letter with its variation selector never splits. A cluster
 *    meets the cluster BEFORE it as its first code point and the one AFTER it as its last (past the marks, selectors,
 *    skin tones and tags that extend it): a head shaking sideways (U+1F642 ZWJ U+2194 U+FE0F) ends in an arrow,
 *    which holds the letters after it, and nothing breaks after a joiner;
 *  - after a zero-width space (U+200B, a run of them), and after a soft hyphen (U+00AD), unless the character after it
 *    holds to it (`packSoftBreakRanges.ts`, scanned in Chromium); never BEFORE either. A line that ends at a soft hyphen
 *    sets a visible hyphen (U+2010), as it does where a soft hyphen ends a word before a space or an ideographic space,
 *    and not where the break falls after a zero-width space, another space or a mark that follows it: `Piece.hyphen`
 *    (a text that ends at one keeps the hyphen's room on its last line, and draws none there).
 *    A word starts after either (a hyphen after one breaks before a letter, not a digit). The line and paragraph
 *    separators always break after them;
 *  - NOT after a slash, dot, comma, colon, ampersand or plus, and not inside a run of ordinary letters.
 * It breaks exactly where Chromium does: a piece the model leaves whole that Chromium breaks is a row refused that would
 * have fitted (and a line count short), a piece the model breaks that Chromium keeps would be a row passed that
 * overflows.
 */
import { breaksBetween } from './packBreakRanges';
import { holdsAfterSoftHyphen, holdsAfterZeroWidthSpace } from './packSoftBreakRanges';

/**
 * A piece of text no line breaks inside. `spaced`: the first piece of every word after the first. `hyphen`: a line
 * that ends after this piece takes a hyphen's width (it ends at a soft hyphen): the hyphen shows there, but for the
 * text's last piece, where Chromium keeps the room and draws nothing (`pieces`).
 */
export interface Piece { text: string; spaced: boolean; hyphen: boolean }

const HYPHEN = '-';
const EN_DASH = '–';
const EM_DASH = '—';

const ZWJ = '\u200D';
const SOFT_HYPHEN = '\u00AD';
const ZWSP = '\u200B';
/** The one break-after space a soft hyphen before it still shows its hyphen at (the others drop it). */
const IDEOGRAPHIC_SPACE = '\u3000';
/** The space separators Chromium breaks after, keeping them on the line they end (they do not hang). */
const BREAK_AFTER_SPACE = /^[\u1680\u2000-\u2006\u2008-\u200A\u2028\u2029\u205F\u3000]$/u;
/**
 * Punctuation Chromium breaks after, between two word clusters (measured: "ab?cd", "12\u202634", "ab\u2010Cd",
 * "12\u201234"; a scan of every character the faces set between letters and digits). Before a quote or a bracket it is
 * not measured here, and the model takes no break there.
 */
const BREAK_AFTER_PUNCTUATION = new Set(['?', '\u2010', '\u2012', '\u2026']);
/** The acute accent: Chromium breaks before it, after a word cluster ("ab|\u00B4cd", "12|\u00B434"). */
const ACUTE = '\u00B4';
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
/** A letter or digit that is not an ideograph, kana or other wide form (the iteration mark 々 is a letter that never takes a break before it). */
const isPlain = (code: number): boolean => /[\p{L}\p{N}]/u.test(String.fromCodePoint(code)) && !breaksBetween(code)
  && !WIDE_RANGES.some(([from, to]) => code >= from && code <= to);
/** A word cluster: a plain letter or digit with only combining marks after it (not a keycap or an emoji presentation). */
const isWordCluster = (cluster: string | undefined): boolean => cluster !== undefined
  && /^[\p{L}\p{N}]\p{M}*$/u.test(cluster) && !/[\uFE0E\uFE0F\u20E3]/u.test(cluster) && isPlain(cluster.codePointAt(0)!);

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

/** A soft hyphen with the marks after it (Chromium breaks after the marks, and shows no hyphen there). */
const isSoftHyphen = (cluster: string): boolean => cluster.startsWith(SOFT_HYPHEN);

/** `word`'s grapheme clusters, a soft hyphen taking the combining marks after it. */
function wordClusters(word: string): string[] {
  const out: string[] = [];
  for (const cluster of clustersOf(word)) {
    const last = out[out.length - 1];
    if (last !== undefined && isSoftHyphen(last) && /^\p{M}+$/u.test(cluster)) out[out.length - 1] = last + cluster;
    else out.push(cluster);
  }
  return out;
}

/** The cluster the rules see before `clusters[i]`: after a soft hyphen or a zero-width space, a word starts. */
const previousOf = (clusters: readonly string[], i: number): string | undefined => {
  const prev = clusters[i - 1];
  return prev === undefined || prev === ZWSP || isSoftHyphen(prev) ? undefined : prev;
};

/** The line and paragraph separators: a line always ends after one. */
const MANDATORY = /^[\u2028\u2029]$/;

/**
 * Does Chromium break between `cluster` and `next` for a soft hyphen or a zero-width space (or a separator that always
 * breaks)? Null: none of them decides.
 */
function softBreak(cluster: string, next: string): boolean | null {
  if (MANDATORY.test(cluster)) return true;
  if (cluster === ZWSP) return !holdsAfterZeroWidthSpace(next.codePointAt(0)!);
  if (isSoftHyphen(cluster)) return !holdsAfterSoftHyphen(next.codePointAt(0)!);
  if (next === ZWSP || isSoftHyphen(next)) return false;
  return null;
}

/** The pieces of one word. */
function wordPieces(word: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  const clusters = wordClusters(word);
  clusters.forEach((cluster, i) => {
    const next = clusters[i + 1];
    if (next === undefined) return;
    const soft = softBreak(cluster, next);
    if (soft !== null) {
      if (soft) {
        pieces.push(clusters.slice(start, i + 1).join(''));
        start = i + 1;
      }
      return;
    }
    const prev = previousOf(clusters, i);
    // After a word, a hyphen breaks before a word, another hyphen or an em dash; one that opens the word or follows
    // another breaks before a letter (not a digit: "-5" is a sign).
    const afterHyphen = cluster === HYPHEN && (isWordCluster(prev)
      ? isWordCluster(next) || next === HYPHEN || next === EM_DASH
      : (prev === undefined || prev === HYPHEN) && isWordCluster(next) && /^\p{L}/u.test(next));
    const afterDash = afterHyphen || (cluster === EN_DASH && isWordCluster(prev) && isWordCluster(next));
    const aroundEm = (cluster === EM_DASH && isWordCluster(next)) || (next === EM_DASH && isWordCluster(cluster));
    const afterSpace = BREAK_AFTER_SPACE.test(cluster) && !BREAK_AFTER_SPACE.test(next);
    const between = breaksBetweenClusters(cluster, next);
    const punctuation = (BREAK_AFTER_PUNCTUATION.has(cluster) && isWordCluster(prev) && isWordCluster(next)) || (next === ACUTE && isWordCluster(cluster));
    if (afterDash || aroundEm || afterSpace || between || punctuation) {
      pieces.push(clusters.slice(start, i + 1).join(''));
      start = i + 1;
    }
  });
  pieces.push(clusters.slice(start).join(''));
  return pieces;
}

/** Does a line that ends after `piece` show a hyphen? It ends at a soft hyphen (or one and ideographic spaces). */
const endsAtSoftHyphen = (piece: string): boolean => piece.replace(new RegExp(`${IDEOGRAPHIC_SPACE}+$`, 'u'), '').endsWith(SOFT_HYPHEN);

/**
 * `text` as its pieces, in order. The LAST piece keeps its hyphen too: where the text ends at a soft hyphen (before any
 * trailing space), Chromium's line breaker still leaves room for the hyphen on the last line, though it draws none
 * there. Measured: "Revenue growth­" sets on one line at 5876/64px (its words and the hyphen), not at the 5570/64
 * of its words, and "growth­" alone has a min-content of its word and the hyphen (`packLineFit.test.ts`).
 */
export function pieces(text: string): Piece[] {
  return text.split(COLLAPSIBLE).filter((word) => word !== '').flatMap((word, wi) => wordPieces(word)
    .map((piece, pi) => ({ text: piece, spaced: wi > 0 && pi === 0, hyphen: endsAtSoftHyphen(piece) })));
}

/**
 * `text`'s pieces when a footnote mark follows it (`marked`, the `<sup>` printed straight after the label). Chromium's
 * line breaker reads across the `<sup>`: it breaks before the mark wherever it would break before a digit (the mark's
 * first character), and the mark is then a word of its own, an empty piece a line can end before:
 *  - after a collapsible space (a tenant's GL name can end at one), which stays, one space, before the mark
 *    (`spaced`): "Gross margin " with mark 3 sets on one line at 5048/64px, its words, the space and the mark;
 *  - after a soft hyphen, a hyphen, a dash, a zero-width space or a break-after space, glued (`spaced: false`):
 *    "Gross margin\u00AD" with mark 1 is 3 lines in a 41.97px column (its min-content, the word and its hyphen), the
 *    line before the mark taking the hyphen, and the mark on one with no hyphen's room.
 * Elsewhere the mark stays with the last piece (`packLabelMark.test.ts`). Held to Chromium, ending by ending, in
 * `packLineFit.test.ts`.
 */
export function markedPieces(text: string, marked: boolean): Piece[] {
  const out = pieces(text);
  if (!marked || out.length === 0) return out;
  if (/[ \t\n\r]$/.test(text)) return [...out, { text: '', spaced: true, hyphen: false }];
  return pieces(`${text}0`).length > out.length ? [...out, { text: '', spaced: false, hyphen: false }] : out;
}
