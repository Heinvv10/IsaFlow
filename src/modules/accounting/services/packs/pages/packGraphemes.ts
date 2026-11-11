/**
 * A TEXT'S GRAPHEME CLUSTERS, IN TIME LINEAR IN ITS LENGTH. `Intl.Segmenter` takes time that grows faster than a
 * text's length on one long string (25,000 characters in 64ms, 100,000 in about a second, on velo's V8; worse on Hangul,
 * emoji and marks), and tenant text reaches the pack's splitter and rulers at any length (#1263 security review, round
 * 2). So it is segmented a window of WINDOW code units at a time: every cluster of a window but its last is kept, and
 * the next window starts where that last cluster starts. A boundary is decided by what stands before it and the one
 * character after it, and the context Unicode's rules read further back (a regional-indicator pair, an emoji ZWJ
 * sequence, an Indic conjunct) lies inside one cluster, so a window that starts at a boundary sees what a whole-text
 * segmentation sees. A window holding one cluster only is widened until it holds two, or the text ends. The clusters are
 * `Intl.Segmenter`'s, exactly (`packGraphemes.test.ts`). Client-safe.
 */
const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const WINDOW = 512;

export interface Grapheme { segment: string; index: number }

/**
 * Text below U+0300 but for CR: each code unit is a cluster of its own (no character there extends or joins another;
 * only CR LF clusters), so it is not segmented. The pack's wording is almost all of it, and segmenting it made the
 * composition slow (#1263: the unit suite ran past CI's job cap).
 */
const ONE_UNIT_CLUSTERS = /^[\u0000-\u000C\u000E-\u02FF]*$/;

/** `text`'s grapheme clusters with their offsets in it, as `Intl.Segmenter` gives them. */
export function graphemes(text: string): Grapheme[] {
  if (ONE_UNIT_CLUSTERS.test(text)) return Array.from(text, (segment, index) => ({ segment, index }));
  const out: Grapheme[] = [];
  let start = 0;
  let width = WINDOW;
  while (start < text.length) {
    let end = Math.min(text.length, start + width);
    // Never inside a surrogate pair: half a character after the last-but-one cluster would be another character. The
    // unit BEFORE the cut decides it (a lone low surrogate after a whole pair is a character of its own).
    const unit = text.charCodeAt(end - 1);
    if (end < text.length && unit >= 0xd800 && unit <= 0xdbff) end -= 1;
    const found = Array.from(SEGMENTER.segment(text.slice(start, end)), ({ segment, index }) => ({ segment, index: start + index }));
    if (end === text.length) { out.push(...found); break; }
    if (found.length < 2) { width *= 2; continue; }
    out.push(...found.slice(0, -1));
    start = found[found.length - 1]!.index;
    width = WINDOW;
  }
  return out;
}

/** `text`'s grapheme clusters. */
export const clusters = (text: string): string[] => graphemes(text).map((g) => g.segment);
