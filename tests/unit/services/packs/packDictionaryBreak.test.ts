/**
 * A `.pack-dictionary` SPAN HOLDS WHOLE GRAPHEME CLUSTERS (#1263 round 3). `dictionaryRuns` cuts a text where its
 * dictionary-script runs begin and end, and a cut inside a cluster sets its base and its marks in two inline boxes:
 * "m" with a Myanmar vowel sign printed as a base and a lone mark on a dotted circle. Every cut here is a cluster
 * boundary, and a cluster goes with its base, on the round-3 patterns and on seeded mixtures of the scripts and marks.
 */
import { describe, expect, it } from 'vitest';
import { dictionaryRuns, isDictionaryCluster } from '@/modules/accounting/services/packs/pages/packDictionaryBreak';
import { graphemes } from '@/modules/accounting/services/packs/pages/packGraphemes';
import { ROUND3_PATTERNS } from '../../print/fixtures/dictionaryScriptRound3';

let seed = 5;
const r = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const POOL = ['m', 'x', 'A', ' ', '(', '%', '1', '\u1000', '\u102C', '\u102D', '\u1040', '\u1039', '\u1780', '\u17B6', '\u17D2',
  '\u0E01', '\u0E33', '\u0E48', '\u0E81', '\u0ECE', '\u0301', '\u200D', '\u200C', '\u00AD', '\u200B'];

function cutsAreClusterBoundaries(text: string): boolean {
  const bounds = new Set(graphemes(text).map((g) => g.index));
  let at = 0;
  for (const run of dictionaryRuns(text)) {
    if (!bounds.has(at)) return false;
    if (graphemes(run.text).some((g) => isDictionaryCluster(g.segment) !== run.dictionary)) return false;
    at += run.text.length;
  }
  return at === text.length;
}

describe('dictionaryRuns', () => {
  it('cuts only between clusters, each cluster with its base, on the round-3 patterns', () => {
    for (const [name, pattern] of ROUND3_PATTERNS) expect(cutsAreClusterBoundaries(pattern.repeat(3)), name).toBe(true);
  });

  it('and on 500 seeded mixtures of Latin, the SA scripts, their marks, joiners and breaks', () => {
    const wrong: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const t = Array.from({ length: 5 + Math.floor(r() * 60) }, () => POOL[Math.floor(r() * POOL.length)]).join('');
      if (!cutsAreClusterBoundaries(t)) wrong.push(JSON.stringify(t));
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('keeps a Latin base and the SA mark that extends it out of the span together', () => {
    // U+102D extends the cluster before it (Grapheme_Cluster_Break=Extend); U+102C does not (Unicode makes it a cluster of
    // its own), and as a cluster with no base it is priced at the widest glyph (`packFallbackWidthCore`).
    expect(dictionaryRuns('\u1000m\u102D\u1000')).toEqual([
      { text: '\u1000', dictionary: true }, { text: 'm\u102D', dictionary: false }, { text: '\u1000', dictionary: true }]);
  });
});
