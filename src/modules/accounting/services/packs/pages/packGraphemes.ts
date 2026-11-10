/**
 * A TEXT'S GRAPHEME CLUSTERS, IN TIME LINEAR IN ITS LENGTH. `Intl.Segmenter` takes time that grows faster than a
 * text's length on one long string (25,000 characters in 64ms, 100,000 in about a second, on velo's V8), and tenant
 * text reaches the pack's splitter and rulers at any length (#1263 security review). So a text is segmented in
 * stretches of about CHUNK code units, cut only where two neighbours always fall in two clusters: both a letter,
 * number, punctuation, symbol or space of the Basic Multilingual Plane, none of them a mark, a format character, a
 * Hangul jamo or syllable, or one of the few letters Unicode's GB rules join to a neighbour (below).
 * Where no such cut stands (a run of marks, of Hangul), the stretch runs on to the next. The clusters are
 * `Intl.Segmenter`'s, exactly (`packGraphemes.test.ts` holds them to it). Client-safe.
 */
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const CHUNK = 256;

/** A character that always ends a cluster before the next such character and starts one after the last. */
const PLAIN = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]$/u;
// Marks, format characters and Hangul; the one prepended mark that is a letter (U+0D4E); the two vowels that are letters
// and extend the cluster before them as spacing marks (Thai U+0E33, Lao U+0EB3); the half-width voiced marks, letters that
// extend it (U+FF9E, U+FF9F).
const JOINS = /^[\p{M}\p{Cf}\p{Script=Hangul}\u0D4E\u0E33\u0EB3\uFF9E\uFF9F]$/u;
const plain = (ch: string | undefined): boolean => ch !== undefined && ch.length === 1 && PLAIN.test(ch) && !JOINS.test(ch);

export interface Grapheme { segment: string; index: number }

/** `text`'s grapheme clusters with their offsets in it, as `Intl.Segmenter` gives them. */
export function graphemes(text: string): Grapheme[] {
  const out: Grapheme[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK);
    while (end < text.length && !(plain(text[end - 1]) && plain(text[end]))) end += 1;
    for (const { segment, index } of SEGMENTER.segment(text.slice(start, end))) out.push({ segment, index: start + index });
    start = end;
  }
  return out;
}

/** `text`'s grapheme clusters. */
export const clusters = (text: string): string[] => graphemes(text).map((g) => g.segment);
