/**
 * WHAT A MARK COSTS WHERE THE TABLE DID NOT MEASURE IT (#1263 round 5). `packFallbackMarkData` holds what a mark adds
 * right after its base, and after itself or a Latin letter. A mark after a joiner, a selector or a format character, a
 * selector stack, the third mark on one base and the second mark of a pair the table reads at nothing are sequences
 * production sets on a dotted circle or a stack, up to half again wider (page 4 at the commentary cap printed 13 sheets, up
 * to 1127px against 966); the widest glyph (or an em, for a second mark) is the price. What the table measured is unchanged.
 * Held to production's image in `printParity/packProseMarksR5Image.test.ts`. Clusters are written as code points.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK_MARKS } from '@/modules/accounting/services/packs/pages/packFallbackMarkData';
import { FALLBACK } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import { fallbackAdvancePx, fallbackClusterPx } from '@/modules/accounting/services/packs/pages/packFallbackWidth';
import { proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { ROUND5_CELLS } from '../../print/fixtures/adversaryRound5Texts';

const widest = FALLBACK.label400.widest;
const ZWJ = 0x200d;
const ZWNJ = 0x200c;
const VS1 = 0xfe00;
const VS16 = 0xfe0f;
/** A cluster's cost in pixels at the size the table is measured at. */
const cost = (...cps: number[]): number => fallbackClusterPx(String.fromCodePoint(...cps), 'label400', 12, 12, true);
const adv = (cp: number): number => fallbackAdvancePx(cp, 'label400');
const inWord = (cp: number): number => FALLBACK_MARKS.find((row) => row[0] === cp)![1];
const elsewhere = (cp: number): number => FALLBACK_MARKS.find((row) => row[0] === cp)![2];

describe('a mark after a joiner, a selector or a format character costs the widest glyph (H1)', () => {
  it('after ZWJ or ZWNJ: Khmer, Myanmar, Devanagari, Gujarati, Odia, Bengali', () => {
    for (const [base, mark] of [[0x1780, 0x17b6], [0x1780, 0x17bf], [0x1000, 0x1037], [0x1000, 0x1032], [0x915, 0x93c], [0xa95, 0xabc], [0xb15, 0xb3c], [0x995, 0x9bc]] as const) {
      for (const joiner of [ZWJ, ZWNJ]) {
        expect(cost(base, joiner, mark), `${base.toString(16)} ${joiner.toString(16)} ${mark.toString(16)}`).toBe(adv(base) + widest);
      }
    }
  });

  it('after a variation selector, VS16 included, and after another format character (the word joiner)', () => {
    expect(cost(0x995, VS16, 0x9cb)).toBeGreaterThanOrEqual(adv(0x995) + widest);
    expect(cost(0x995, VS1, 0x9cb)).toBe(cost(0x995, VS1) + widest);
    expect(cost(0xc95, VS16, 0xcc7)).toBeGreaterThanOrEqual(adv(0xc95) + widest);
    expect(cost(0x1780, 0x2060, 0x17b6)).toBe(adv(0x1780) + adv(0x2060) + widest);
  });

  it('but not after a virama, a joiner and a consonant (Sinhala and Hindi conjuncts keep the table\'s reading)', () => {
    expect(cost(0xd9a, 0xdca, ZWJ, 0xdbb, 0xdd2)).toBe(adv(0xd9a) + inWord(0xdca) + adv(0xdbb) + inWord(0xdd2));
    expect(cost(0x915, 0x94d, 0x937, 0x93f)).toBe(adv(0x915) + inWord(0x94d) + adv(0x937) + inWord(0x93f));
  });
});

describe('a selector is measured only right after its base (M2, L3)', () => {
  it('prices one selector on its base as the table does', () => {
    expect(cost(0x1000, VS1)).toBe(adv(0x1000) + inWord(VS1));
  });

  it('a second and every further selector costs the widest glyph, of any kind', () => {
    expect(cost(0x1000, VS1, VS1)).toBe(cost(0x1000, VS1) + widest);
    expect(cost(0x1000, VS1, VS1, VS1, VS1, VS1)).toBe(cost(0x1000, VS1) + 4 * widest);
    expect(cost(0x1000, VS1, 0xe0100, VS1)).toBe(cost(0x1000, VS1) + 2 * widest);
  });

  it('a selector after a mark costs the widest glyph, whatever the order (a deprecated tonos mark on Thai, Khmer, Devanagari)', () => {
    for (const base of [0xe01, 0x1780, 0x915]) {
      expect(cost(base, 0x340, VS1)).toBeGreaterThanOrEqual(cost(base, 0x340) + widest);
      expect(cost(base, VS1, 0x341)).toBeGreaterThanOrEqual(cost(base, VS1) + widest);
    }
  });

  it('leaves the emoji sequences as they were: a keycap, a heart on fire, an eye in a speech bubble', () => {
    const emoji = FALLBACK.label400.emoji;
    expect(cost(0x31, VS16, 0x20e3)).toBe(Math.max(emoji, adv(0x31) + inWord(VS16) + widest));
    expect(cost(0x2764, VS16, ZWJ, 0x1f525)).toBe(Math.max(emoji, adv(0x2764) + inWord(VS16) + adv(0x1f525)));
    expect(cost(0x1f441, VS16, ZWJ, 0x1f5e8, VS16)).toBe(Math.max(emoji, adv(0x1f441) + inWord(VS16) + adv(0x1f5e8) + inWord(VS16)));
  });
});

describe('the third mark in an unbroken run costs the widest glyph (M1, L2)', () => {
  it('Lao: a base with three or more marks', () => {
    expect(cost(0xe9a, 0xeba, 0xecc, 0xecd)).toBe(cost(0xe9a, 0xeba, 0xecc) + widest);
    expect(cost(0xe9a, 0xecd, 0xece, 0xeca, 0xeb1, 0xeb4, 0xeb6)).toBe(cost(0xe9a, 0xecd, 0xece) + 4 * widest);
  });

  it('Ethiopic: a gemination mark three times over', () => {
    expect(cost(0x1214, 0x135f, 0x135f, 0x135f)).toBeGreaterThanOrEqual(cost(0x1214, 0x135f, 0x135f) + widest);
  });

  it('a run broken by a letter starts again: a conjunct\'s viramas do not count with the vowel sign after them', () => {
    expect(cost(0x938, 0x94d, 0x924, 0x94d, 0x930, 0x940)).toBe(adv(0x938) + inWord(0x94d) + adv(0x924) + elsewhere(0x94d) + adv(0x930) + inWord(0x940));
  });
});

describe('the second mark of a run costs at least an em, the dotted circle (Lao, Odia, Thai pairs the table reads at nothing)', () => {
  it('Lao pali virama and YAMAKKAN with a vowel; Odia U+0B55 after a mark', () => {
    expect(cost(0xe9a, 0xeb1, 0xeba)).toBe(adv(0xe9a) + inWord(0xeb1) + 12);
    expect(cost(0xea2, 0xece, 0xeb6)).toBe(adv(0xea2) + inWord(0xece) + 12);
    expect(cost(0xb27, 0xb01, 0xb55)).toBeGreaterThanOrEqual(adv(0xb27) + inWord(0xb01) + 12);
  });

  it('a mark repeated costs an em too, not the nothing it adds after itself', () => {
    expect(elsewhere(0x135f)).toBeLessThan(12);
    expect(cost(0x1214, 0x135f, 0x135f)).toBeGreaterThanOrEqual(adv(0x1214) + inWord(0x135f) + 12);
  });

  it('is never less than the round-4 reading (the larger of in a word and elsewhere)', () => {
    for (const [base, first, second] of [[0x1000, 0x102f, 0x102d], [0x915, 0x902, 0x93f]] as const) {
      expect(cost(base, first, second)).toBeGreaterThanOrEqual(adv(base) + inWord(first) + Math.max(inWord(second), elsewhere(second)));
    }
  });
});

describe('a mark seen earlier in its cluster costs what it adds elsewhere, adjacent or not (round 4 C2)', () => {
  it('a virama repeated in a conjunct, a letter between the two', () => {
    expect(inWord(0x94d)).not.toBe(elsewhere(0x94d));
    expect(cost(0x915, 0x94d, 0x937, 0x94d)).toBe(adv(0x915) + inWord(0x94d) + adv(0x937) + elsewhere(0x94d));
    expect(cost(0x915, 0x94d, 0x937, 0x94d, 0x924, 0x94d)).toBe(adv(0x915) + inWord(0x94d) + adv(0x937) + 2 * elsewhere(0x94d) + adv(0x924));
  });

  it('a vowel sign repeated after another sign: its elsewhere value, at least an em', () => {
    expect(cost(0x1780, 0x17b6, 0x17c6, 0x17b6)).toBeGreaterThanOrEqual(adv(0x1780) + inWord(0x17b6) + Math.max(inWord(0x17c6), elsewhere(0x17c6), 12) + elsewhere(0x17b6));
  });
});

describe('the gate still bounds the page model on every text the round-5 reviews found short', () => {
  it('at the narrative\'s measures', () => {
    const short: string[] = [];
    for (const pattern of ROUND5_CELLS) {
      const text = pattern.repeat(Math.ceil(300 / pattern.length));
      for (const mm of [174, 110, 60, 24.4]) {
        if (proseLinesBound(text, PROSE.narrativeBody, mm) < proseLines(text, PROSE.narrativeBody, mm)) short.push(`${JSON.stringify(pattern.slice(0, 6))} at ${mm}mm`);
      }
    }
    expect(short.slice(0, 10)).toEqual([]);
  }, 120_000);
});
