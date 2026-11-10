/**
 * WHERE CHROMIUM MAY BREAK A LABEL, A REASON OR A DELTA LINE: the one splitter of the fit model.
 *
 * The fit's minimum widths (`packFigureFit.ts`), the statement table's layout and the KPI model all break text into
 * pieces with it; they used to split at slightly different places, and a hyphenated label was refused by one and
 * wrapped by the other. Measured in Chromium (`packLineBreaks.test.ts`), which is NOT what UAX 14 reads like:
 *  - a break is allowed at a collapsible space (space, tab, line feed, carriage return: it hangs, so it adds nothing
 *    to either line);
 *  - between two characters the pack's faces set, where the pair table says (`packBreakPairs.ts`, scanned in production's
 *    image): by the classes of the two and of what stands either side of them, the hyphens and dashes ("2024-25" breaks
 *    after "2024-", "-5" holds), punctuation ("ab?cd", "12\u202634"), quotes, brackets ("!(" breaks before the bracket),
 *    signs and currency, and the spaces Chromium breaks after (U+2000 to U+200A but U+2007: the run stays on the line it
 *    ends) or holds at (the no-break spaces);
 *  - where a character the faces lack stands, between two grapheme clusters that Chromium breaks between
 *    (`packBreakRanges.ts`: ideographs, kana, Hangul, full-width forms, emoji), and after the space separators the faces
 *    lack (U+1680, U+205F, U+3000). A cluster is one piece of the
 *    run: a ZWJ family, a skin-toned hand, a flag or a letter with its variation selector never splits. A cluster
 *    meets the cluster BEFORE it as its first code point and the one AFTER it as its last (past the marks, selectors,
 *    skin tones and tags that extend it): a head shaking sideways (U+1F642 ZWJ U+2194 U+FE0F) ends in an arrow,
 *    which holds the letters after it, and nothing breaks after a joiner;
 *  - after a zero-width space (U+200B, a run of them), and after a soft hyphen (U+00AD), unless the character after it
 *    holds to it (`packSoftBreakRanges.ts`, scanned in Chromium); never BEFORE either. A line that ends at a soft hyphen
 *    sets a visible hyphen (U+2010), as it does where a soft hyphen ends a word before a space or an ideographic space,
 *    and not where the break falls after a zero-width space, another space or a mark that follows it: `Piece.hyphen`
 *    (a text that ends at one keeps the hyphen's room on its last line, and draws none there).
 *    The line and paragraph separators always break after them.
 * Between two characters the pair table covers, it breaks where production's Chromium does on every census the image
 * tests hold (`printParity/packBreakPairsImage.test.ts`, `printParity/packNumericHoldImage.test.ts`): the pairs in
 * every context of one character either side, Unicode's numeric rule past them, the reviews' censuses. Text holding a
 * combining mark or a variation selector never reaches it: a row label is printed to break anywhere and measured as such
 * (`packAnywhereLabel.ts`), and a KPI tile refuses it. Not held, and known to differ (#1235 round 4, for a follow-up):
 * full-width punctuation and the wide currency signs, which take the fallback rules, and a hyphen after U+2028. A
 * piece the model leaves whole that Chromium breaks is a row refused that would have fitted (and a line count short),
 * a piece the model breaks that Chromium keeps would be a row passed that overflows.
 */
import { AFTER, BEFORE, contextOf, pairBreaks, pairClass } from './packBreakPairs';
import { breaksBetween } from './packBreakRanges';
import { clusters } from './packGraphemes';
import { heldByNumber } from './packNumericHold';
import { holdsAfterSoftHyphen, holdsAfterZeroWidthSpace } from './packSoftBreakRanges';

/**
 * A piece of text no line breaks inside. `spaced`: the first piece of every word after the first. `hyphen`: a line
 * that ends after this piece takes a hyphen's width (it ends at a soft hyphen): the hyphen shows there, but for the
 * text's last piece, where Chromium keeps the room and draws nothing (`pieces`).
 */
export interface Piece { text: string; spaced: boolean; hyphen: boolean }

const ZWJ = '\u200D';
const SOFT_HYPHEN = '\u00AD';
const ZWSP = '\u200B';
/** The one break-after space a soft hyphen before it still shows its hyphen at (the others drop it). */
const IDEOGRAPHIC_SPACE = '\u3000';
/** The space separators the faces lack that Chromium breaks after, keeping them on the line they end (they do not hang). */
const BREAK_AFTER_SPACE = /^[\u1680\u205F\u3000]$/u;
/** The white space CSS collapses: the only separators a break consumes. */
const COLLAPSIBLE = /[ \t\n\r]+/;

/** A word's grapheme clusters (`packGraphemes`: `Intl.Segmenter`'s, in time linear in the word). */
const clustersOf = (word: string): string[] => clusters(word);

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
/** Extends the code point before it: a mark (variation selectors, the keycap), a skin tone, a tag. */
const EXTENDS = /[\p{Grapheme_Extend}\p{Emoji_Modifier}\u{E0020}-\u{E007F}]/u;

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

/**
 * The prepended concatenation marks (Grapheme_Cluster_Break=Prepend, to U+30FF): a cluster with the character after
 * them, but Chromium's line breaker reads them as characters of their own ("ab\u0600\u4E2D" breaks before the ideograph).
 */
const PREPEND = /^[\u0600-\u0605\u06DD\u070F\u0890\u0891\u08E2\u0D4E]/u;

/** `word`'s grapheme clusters, a soft hyphen taking the combining marks after it, a prepended mark on its own. */
function wordClusters(word: string): string[] {
  const out: string[] = [];
  for (const whole of clustersOf(word)) {
    let cluster = whole;
    while (cluster.length > 1 && PREPEND.test(cluster)) { out.push(cluster[0]!); cluster = cluster.slice(1); }
    const last = out[out.length - 1];
    if (last !== undefined && isSoftHyphen(last) && /^\p{M}+$/u.test(cluster)) out[out.length - 1] = last + cluster;
    else out.push(cluster);
  }
  return out;
}

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

/**
 * The pair class `cluster` meets a neighbour with at `code`: its base's, a variation selector after it too (Chromium
 * breaks beside "\u263A\uFE0F" as beside the base, on the whole census of them as the pack prints them, where the selector
 * after a character with no emoji presentation is dropped: `packPrintedText.ts`, `packBreakPairs.test.ts`);
 * none for a keycap ("1\uFE0F\u20E3" is not a digit to Chromium: `packBreakRanges`).
 */
const classOf = (cluster: string, code: number | null): number | null => (code === null || cluster.includes('\u20E3') ? null : pairClass(code));

/** The context before `clusters[i]` (`packBreakPairs.BEFORE`): `first`, the text's first word. */
function beforeContext(clusters: readonly string[], i: number, first: boolean): number {
  const prev = clusters[i - 1];
  if (prev === undefined) return first ? BEFORE.start : BEFORE.space;
  if (prev === ZWSP) return BEFORE.zeroWidthSpace;
  if (isSoftHyphen(prev)) return BEFORE.softHyphen;
  return contextOf(classOf(prev, trailingCode(prev)));
}

/** The context after `clusters[i]` (`packBreakPairs.AFTER`): `last`, the text's last word. */
function afterContext(clusters: readonly string[], i: number, last: boolean): number {
  const next = clusters[i + 1];
  if (next === undefined) return last ? AFTER.end : AFTER.space;
  if (next === ZWSP) return AFTER.zeroWidthSpace;
  if (isSoftHyphen(next)) return AFTER.softHyphen;
  return contextOf(classOf(next, next.codePointAt(0)!));
}

/**
 * Does Chromium break between `clusters[i]` and the cluster after it (not at a soft hyphen or a zero-width space)? By the
 * pair table where it covers both, but where the numeric rule holds what the table's one character of context cannot
 * see (`packNumericHold.ts`; `codes`, each cluster's base code point); by the ranges and spaces of the faces' fallback
 * otherwise.
 */
function breaksAfter(clusters: readonly string[], codes: readonly number[], i: number, first: boolean, last: boolean): boolean {
  const cluster = clusters[i]!;
  const next = clusters[i + 1]!;
  const a = classOf(cluster, trailingCode(cluster));
  const b = classOf(next, next.codePointAt(0)!);
  if (a !== null && b !== null) return pairBreaks(beforeContext(clusters, i, first), a, b, afterContext(clusters, i + 1, last)) && !heldByNumber(codes, i);
  return (BREAK_AFTER_SPACE.test(cluster) && !BREAK_AFTER_SPACE.test(next)) || breaksBetweenClusters(cluster, next);
}

/** The pieces of one word, the text's `first` and `last` or not. */
function wordPieces(word: string, first: boolean, last: boolean): string[] {
  const pieces: string[] = [];
  let start = 0;
  const clusters = wordClusters(word);
  const codes = clusters.map((c) => c.codePointAt(0)!);
  clusters.forEach((cluster, i) => {
    const next = clusters[i + 1];
    if (next === undefined) return;
    const soft = softBreak(cluster, next);
    if (soft === null ? breaksAfter(clusters, codes, i, first, last) : soft) {
      pieces.push(clusters.slice(start, i + 1).join(''));
      start = i + 1;
    }
  });
  pieces.push(clusters.slice(start).join(''));
  return pieces;
}

/** Does a line that ends after `piece` show a hyphen? It ends at a soft hyphen (or one and ideographic spaces). */
const endsAtSoftHyphen = (piece: string): boolean => {
  // A loop, not a trailing-run regex: that backtracks over a long run of ideographic spaces (#1263 round 2).
  let end = piece.length;
  while (end > 0 && piece[end - 1] === IDEOGRAPHIC_SPACE) end -= 1;
  return end > 0 && piece[end - 1] === SOFT_HYPHEN;
};

/**
 * `text` as its pieces, in order. The LAST piece keeps its hyphen too: where the text ends at a soft hyphen (before any
 * trailing space), Chromium's line breaker still leaves room for the hyphen on the last line, though it draws none
 * there. Measured: "Revenue growth­" sets on one line at 5876/64px (its words and the hyphen), not at the 5570/64
 * of its words, and "growth­" alone has a min-content of its word and the hyphen (`packLineFit.test.ts`).
 */
export function pieces(text: string): Piece[] {
  const words = text.split(COLLAPSIBLE).filter((word) => word !== '');
  return words.flatMap((word, wi) => wordPieces(word, wi === 0, wi === words.length - 1)
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
 * Elsewhere the mark stays with the last piece (`packLabelMark.test.ts`). The digit can also hold together what stands
 * before it: a sign before a bracket or a low quote holds to it before a number ("ab\u20AC(" is two pieces, and one
 * with a mark), so the pieces are the text's with a digit after it. Held to Chromium, ending by ending, in
 * `packLineFit.test.ts`, and on the adversary's census in `packBreakPairs.test.ts`.
 */
export function markedPieces(text: string, marked: boolean): Piece[] {
  const out = pieces(text);
  if (!marked || out.length === 0) return out;
  if (/[ \t\n\r]$/.test(text)) return [...out, { text: '', spaced: true, hyphen: false }];
  const withMark = pieces(`${text}0`);
  const last = withMark[withMark.length - 1]!;
  const same = (list: readonly Piece[]): boolean => list.length === out.length
    && list.every((p, i) => p.text === out[i]!.text && p.spaced === out[i]!.spaced && p.hyphen === out[i]!.hyphen);
  if (last.text === '0') {
    const before = withMark.slice(0, -1);
    return [...(same(before) ? out : before), { text: '', spaced: false, hyphen: false }];
  }
  const kept = last.text.slice(0, -1);
  const joined = [...withMark.slice(0, -1), { text: kept, spaced: last.spaced, hyphen: endsAtSoftHyphen(kept) }];
  return same(joined) ? out : joined;
}
