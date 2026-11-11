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
  'a', 'Z', '1', ' ', '-', '\u4E00', '\u30D0', '\u{20000}', '\u{1F44D}', '\u{1F3FD}', '\u{1F1FF}', '\u{111C2}', '\u{11A84}', '\uA960', '\uD7B0',
  '\u0D4E', '\u{E0020}', '\u{E007F}',
];
function randomText(n: number): string {
  let s = '';
  while (s.length < n) {
    const k = r();
    if (k < 0.45) s += SPECIAL[Math.floor(r() * SPECIAL.length)];
    else if (k < 0.8) {
      const cp = Math.floor(r() * 0xffff);
      if (cp < 0xd800 || cp > 0xdfff) s += String.fromCodePoint(cp);
    } else if (k < 0.9) s += String.fromCodePoint(0x10000 + Math.floor(r() * 0x30000));
    else s += 'abcdefgh'.slice(0, 1 + Math.floor(r() * 8));
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

  it('and on runs with no plain neighbour: astral ideographs, emoji with skin tones, flags, Hangul, one letter\'s marks', () => {
    for (const unit of ['\u{20000}', '\u{1F44D}\u{1F3FD}', '\u{1F1FF}', '\u{1F1FF}\u{1F1E6}', '\uAC01', '\u1100\u1161\u11A8', 'a\u0301', '\u{1F600}', '\u3000', '\u0915\u094D', '\u{1F468}\u200D']) {
      for (const n of [255, 256, 257, 600]) {
        const t = unit.repeat(n);
        expect(graphemes(t), `${JSON.stringify(unit)} x ${n}`).toEqual(reference(t));
      }
    }
  });

  it('and at every window edge: the round-3 review\'s 20,481 cases, lone surrogates included (its 7 were cut in half)', () => {
  const units = ['\u{1F1FF}\u{1F1E6}', '\u{1F1FF}', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '\u{1F44D}\u{1F3FD}', '\u0915\u094D\u0937', '\u0915\u094D\u200D\u0937',
    '\u1100\u1161\u11A8', '\uAC00\u11A8', 'e\u0301\u0302', '\r\n', '\u0600a', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', '\u{20000}', '\u{1F600}\uFE0F', '\u0E01\u0E33', '\uFF76\uFF9E', '\u{111C2}\u{11180}', '\uD800', '\uDC00', 'a\uDC00', '\u{1F1E6}\u{1F1E6}\u{1F1E6}'];
  const fillers = ['x', '\u{1F1FF}', '\u0301', '\uAC00', '\u{20000}', '\u{1F468}\u200D', '\u1100'];
  const wrong: string[] = [];
  let n = 0;
  for (const filler of fillers) for (const u of units) for (let pre = 490; pre <= 530; pre += 1) for (const wlen of [512, 1024, 2048]) {
    let p = ''; while (p.length < pre + (wlen - 512)) p += filler;
    p = p.slice(0, pre + (wlen - 512));
    const t = p + u + u + 'tail' + u;
    n += 1;
    const g = graphemes(t); const r = reference(t);
    if (JSON.stringify(g) !== JSON.stringify(r)) wrong.push(`${JSON.stringify(filler)} pre ${pre + wlen - 512} unit ${JSON.stringify(u)}`);
  }
  // random-length RI runs (parity) and long ZWJ chains
  for (let k = 500; k < 1100; k += 1) {
    for (const t of ['\u{1F1FF}'.repeat(k), 'a' + '\u{1F1FF}'.repeat(k), '\u{1F468}\u200D'.repeat(k) + '\u{1F468}', 'x'.repeat(k) + '\u{1F468}\u200D'.repeat(300)]) {
      n += 1;
      if (JSON.stringify(graphemes(t)) !== JSON.stringify(reference(t))) wrong.push(`k ${k} ${JSON.stringify(t.slice(0, 4))}`);
    }
  }
    expect(wrong.slice(0, 10), `${wrong.length} of ${n}`).toEqual([]);
  }, 600_000);

  it('segments every run the round-2 reviews timed, at 64,000 to 128,000 characters, each in well under a second', () => {
    for (const [unit, n] of [['\u{1F1FF}', 128_000], ['\u{20000}', 128_000], ['\u{1F44D}\u{1F3FD}', 64_000], ['\uAC01', 128_000], ['\uAC00', 128_000],
      ['\u{1F600}', 64_000], ['a\u0301', 64_000], ['\u3000', 128_000], ['\u0915\u094D', 64_000]] as const) {
      const t = unit.repeat(n);
      const start = performance.now();
      const got = graphemes(t);
      expect(performance.now() - start, `${JSON.stringify(unit)} x ${n}`).toBeLessThan(800);
      expect(got.map((g) => g.segment).join('') === t).toBe(true);
    }
  }, 60_000);

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
