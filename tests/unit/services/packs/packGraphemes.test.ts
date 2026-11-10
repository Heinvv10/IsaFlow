/**
 * THE LINEAR SEGMENTER IS `Intl.Segmenter`, CLUSTER FOR CLUSTER (#1263 security review). `packGraphemes` cuts a text into
 * stretches where two neighbours always fall in two clusters and segments each; any cut Unicode's rules would join
 * across shows here as a cluster split in two. Seeded random texts over every code point of the Basic Multilingual
 * Plane and the joiners, marks, selectors, jamo, emoji, flags and line ends that the rules treat specially, at lengths
 * that cross many stretches. And the work is linear: four times the text, about four times the time.
 */
import { describe, expect, it } from 'vitest';
import { graphemes } from '@/modules/accounting/services/packs/pages/packGraphemes';

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const reference = (t: string) => Array.from(SEGMENTER.segment(t), ({ segment, index }) => ({ segment, index }));

let seed = 11;
const r = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const SPECIAL = [
  '\u200D', '\uFE0F', '\uFE0E', '\u20E3', '\u0301', '\u0308', '\u093F', '\u094D', '\u0915', '\u0937', '\u0E01', '\u0E33', '\u0EB3',
  '\u1100', '\u1161', '\u11A8', '\uAC00', '\uAC01', '\uFF76', '\uFF9E', '\uFF9F', '\u0D4E', '\u0D15', '\u0600', '\u0661', '\r', '\n',
  '\u{1F468}', '\u{1F469}', '\u{1F3FB}', '\u{1F1FF}', '\u{1F1E6}', '\u2764', '\u263A', '\u{E0067}', '\u{1F3F4}', '\u00AD', '\u200B',
  'a', 'Z', '1', ' ', '-', '\u4E00', '\u30D0',
];
function randomText(n: number): string {
  let s = '';
  while (s.length < n) {
    const k = r();
    if (k < 0.45) s += SPECIAL[Math.floor(r() * SPECIAL.length)];
    else if (k < 0.9) {
      const cp = Math.floor(r() * 0xffff);
      if (cp < 0xd800 || cp > 0xdfff) s += String.fromCodePoint(cp);
    } else s += 'abcdefgh'.slice(0, 1 + Math.floor(r() * 8));
  }
  return s;
}

describe('packGraphemes', () => {
  it('gives Intl.Segmenter\'s clusters and offsets on 400 seeded texts of up to 3,000 code units', () => {
    const wrong: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const t = randomText(50 + Math.floor(r() * 3000));
      const got = graphemes(t);
      const want = reference(t);
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`text ${i}, ${t.length} code units`);
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  }, 120_000);

  it('and on texts the stretches could cut wrongly: a cluster that runs past a stretch, a run of Hangul or marks', () => {
    const cases = ['x'.repeat(255) + '\u0301'.repeat(40) + 'y'.repeat(600), '\uAC00'.repeat(3000), `a${'\u0301'.repeat(3000)}b`,
      `${'ab'.repeat(127)}\u0E01\u0E33${'c'.repeat(500)}`, `${'q'.repeat(255)}\uFF76\uFF9E${'r'.repeat(300)}`, `${'\u{1F468}\u200D'.repeat(200)}z`];
    for (const t of cases) expect(graphemes(t), JSON.stringify(t.slice(250, 262))).toEqual(reference(t));
  });

  it('takes time linear in the text: 100,000 characters at most about four times 25,000', () => {
    const ms = (n: number): number => {
      const t = 'x'.repeat(n);
      let best = Infinity;
      for (let run = 0; run < 3; run += 1) { const start = performance.now(); graphemes(t); best = Math.min(best, performance.now() - start); }
      return best;
    };
    ms(5_000);
    expect(ms(100_000) / Math.max(ms(25_000), 1)).toBeLessThan(8);
  }, 120_000);
});
