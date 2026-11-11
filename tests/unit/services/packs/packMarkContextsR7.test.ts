/**
 * AN EMOJI SEQUENCE COSTS EVERY CODE POINT AT AN EMOJI (#1264, round 7 of #1263). Six rounds had priced emoji sequences one
 * shape at a time and the reviews found the next shape each time: `1 ZWJ heart` (the digit is drawn in the emoji face),
 * a skin tone on a base that takes none (a swatch of its own), `U+1F634 U+FE0E` (19px), a pictograph after a lone
 * modifier or regional indicator (drawn in the emoji face wherever it stands later in the text). One class rule now:
 *  - a pictograph with U+FE0F, and a keycap or a digit/"#"/"*" with U+FE0F, are one emoji: the emoji width;
 *  - any other cluster holding a ZWJ, an emoji modifier, a text or emoji selector, a keycap mark or a tag character costs
 *    at least the sum, over ALL its code points (the ZWJ too: with it at nothing, `tone ZWJ arrows` and `warning ZWJ
 *    registered` read 7px short), of the larger of the code point's advance and an emoji, never less than its own price;
 *  - a cluster that starts with a pictograph costs at least an emoji;
 *  - a cluster holding a ZWJ is priced from the fallback tables even where the faces set every code point of it.
 * The numbers marked "production" are the widths measured in production's image (gotenberg:8, 12px, regular), held by
 * `printParity/packProseMarksR7Image.test.ts` (velo). Blind round 7: M1 (the gap offset counts code points), L2.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import { fallbackAdvancePx, fallbackClusterPx } from '@/modules/accounting/services/packs/pages/packFallbackWidth';
import { textExactPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { boundPx, proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { ROUND7_CHAINS, ROUND7_JOINED, ROUND7_SKIN, ROUND7_TEXT_SELECTOR } from '../../print/fixtures/adversaryRound7Texts';

const { widest, emoji } = FALLBACK.label400;
const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const VS15 = 0xfe0e;
const TONE = 0x1f3fd;
const cost = (...cps: number[]): number => fallbackClusterPx(String.fromCodePoint(...cps), 'label400', 12, 12, true);
const adv = (cp: number): number => fallbackAdvancePx(cp, 'label400');
const part = (cp: number): number => Math.max(adv(cp), emoji);
const sum = (...cps: number[]): number => cps.reduce((s, cp) => s + part(cp), 0);
/** A prose text's width as the ruler prices it, at 12px regular. */
const px = (text: string): number => textExactPx(text, 12, 400, false, true);
const S = String.fromCodePoint;
const KEYCAP_BASES = [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x23, 0x2a];

describe('a pictograph with U+FE0F, and a keycap, are one emoji', () => {
  it('a pictograph and U+FE0F is the emoji width, not the class sum', () => {
    for (const cp of [0x2764, 0x26a0, 0x2b06, 0x1f600, 0x2139, 0x2640]) {
      expect(cost(cp, VS16), cp.toString(16)).toBeGreaterThanOrEqual(emoji);
      expect(cost(cp, VS16), cp.toString(16)).toBeLessThan(sum(cp, VS16));
    }
  });

  it('a keycap and a digit, "#" or "*" with U+FE0F cost the emoji width (production: 14.98px; "0\\u20E3" 12.88px)', () => {
    for (const base of KEYCAP_BASES) {
      for (const tail of [[VS16, 0x20e3], [0x20e3], [VS16]]) expect(cost(base, ...tail), `${base.toString(16)} ${tail.join()}`).toBe(Math.max(emoji, adv(base)));
    }
    expect(px('1\uFE0F\u20E3')).toBeGreaterThanOrEqual(14.98);
    expect(px('0\u20E3')).toBeGreaterThanOrEqual(12.88);
  });

  it('scales with the size', () => {
    expect(fallbackClusterPx('1\uFE0F\u20E3', 'label400', 24, 12, true)).toBe(2 * emoji);
  });

  it('a keycap is the whole cluster: a digit and U+FE0F after a joiner is a class cluster', () => {
    expect(cost(0x61, ZWJ, 0x31, VS16)).toBeGreaterThanOrEqual(sum(0x61, ZWJ, 0x31, VS16));
    expect(cost(0x2764, ZWJ, 0x31, VS16, 0x20e3)).toBeGreaterThanOrEqual(sum(0x2764, ZWJ, 0x31, VS16, 0x20e3));
  });

  it('a keycap with anything more, or a different selector, is a class cluster', () => {
    expect(cost(0x31, VS16, 0x20e3, 0x301)).toBeGreaterThanOrEqual(sum(0x31, VS16, 0x20e3, 0x301));
    expect(cost(0x31, VS15)).toBeGreaterThanOrEqual(sum(0x31, VS15));
    expect(cost(0x61, VS15, 0x20e3)).toBeGreaterThanOrEqual(sum(0x61, VS15, 0x20e3));
  });
});

describe('any other cluster with a ZWJ, a modifier, a selector, a keycap mark or a tag costs the sum of its code points (H1-H4)', () => {
  it('ZWJ: a digit, "#", "*", a letter, CJK beside a joiner (production: "1 ZWJ heart" 29.95px, CJK ZWJ female 24.02px)', () => {
    for (const b of [0x31, 0x39, 0x23, 0x2a, 0x61, 0x4e2d, 0x20]) {
      expect(cost(b, ZWJ), b.toString(16)).toBe(sum(b, ZWJ));
      expect(cost(0x2764, ZWJ, b), b.toString(16)).toBeGreaterThanOrEqual(sum(0x2764, ZWJ, b));
    }
    expect(px('1\u200D\u2764')).toBeGreaterThanOrEqual(29.95);
    expect(px('#\u200D\u{1F600}')).toBeGreaterThanOrEqual(29.95);
    expect(px('\u4E2D\u200D\u2640')).toBeGreaterThanOrEqual(24.02);
    expect(px('\u2764\u200D1')).toBeGreaterThanOrEqual(22.19);
    expect(px('\u26A0\u200D\u200D\u00AE')).toBeGreaterThanOrEqual(22.77);
  });

  it('the joiner counts as an emoji itself (ZWJ at nothing reads "tone ZWJ arrows" 5px short)', () => {
    expect(cost(TONE, ZWJ, 0x2194)).toBe(sum(TONE, ZWJ, 0x2194));
    expect(cost(0x26a0, ZWJ, ZWJ, 0xae)).toBe(sum(0x26a0, ZWJ, ZWJ, 0xae));
    expect(px('\u{1F3FB}\u200D\u2194')).toBeGreaterThanOrEqual(29.95);
  });

  it('a modifier on a base that takes none is a swatch of its own (production: 29.95px)', () => {
    for (const base of [0xa9, 0x2049, 0x25aa, 0x2764, 0x2b05, 0x1f17e]) {
      expect(cost(base, VS16, TONE), base.toString(16)).toBe(sum(base, VS16, TONE));
      expect(px(S(base, VS16, TONE)), base.toString(16)).toBeGreaterThanOrEqual(29.95);
    }
    for (const tone of [0x1f3fb, 0x1f3ff]) expect(cost(0xa9, tone), tone.toString(16)).toBe(sum(0xa9, tone));
    // The range is U+1F3FB to U+1F3FF: its neighbours are ordinary pictographs.
    expect(cost(0x61, 0x1f3fa)).toBe(adv(0x61) + adv(0x1f3fa));
    expect(cost(0x61, 0x1f400)).toBe(adv(0x61) + adv(0x1f400));
  });

  it('a text selector after a pictograph (production: U+1F634 U+FE0E is 19.25px)', () => {
    expect(cost(0x1f634, VS15)).toBe(sum(0x1f634, VS15));
    expect(px('\u{1F634}\uFE0E')).toBeGreaterThanOrEqual(19.25);
    expect(px('\u{1F6FB}\uFE0E')).toBeGreaterThanOrEqual(15.22);
  });

  it('skin tones around a joiner (production: 44.92px)', () => {
    expect(px('\u{1F600}\u{1F3FB}\u200D\u2640\u{1F3FC}')).toBeGreaterThanOrEqual(44.92);
    expect(px('\u{1F3FD}\u200D\u2139\u{1F3FD}')).toBeGreaterThanOrEqual(44.92);
  });

  it('a selector alone, after a letter, is a class cluster', () => {
    expect(cost(0x61, VS16)).toBe(sum(0x61, VS16));
  });

  it('a keycap mark counts in the class (ten text-default pictographs and U+20E3: the sum over the cluster\'s own 157)', () => {
    expect(cost(...Array.from({ length: 10 }, () => 0x2695), 0x20e3)).toBe(11 * emoji);
  });

  it('a tag character is priced at least an emoji', () => {
    expect(cost(0x1f3f4, 0xe0067, 0xe007f)).toBeGreaterThanOrEqual(sum(0x1f3f4, 0xe0067, 0xe007f));
  });

  it('is never less than the cluster\'s own price (Thai: a base, three tone marks and a joiner)', () => {
    expect(cost(0xe01, 0xe48, 0xe49, 0xe4a, ZWJ)).toBeGreaterThan(sum(0xe01, 0xe48, 0xe49, 0xe4a, ZWJ));
    expect(cost(0xe01, 0xe48, 0xe49, 0xe4a, ZWJ)).toBe(cost(0xe01, 0xe48, 0xe49, 0xe4a));
  });

  it('row labels keep the tables\' reading (marks off)', () => {
    expect(fallbackClusterPx(S(0x61, ZWJ), 'label400', 12, 12)).toBe(adv(0x61));
    expect(textExactPx('1\u200D', 12, 400)).toBeLessThan(8);
  });

  it('a Sinhala or Bengali conjunct with a joiner is over-priced by it (accepted: 22px to 75px)', () => {
    expect(cost(0xd9a, 0xdca, ZWJ, 0xdbb, 0xdd2)).toBe(sum(0xd9a, 0xdca, ZWJ, 0xdbb, 0xdd2));
  });
});

describe('a pictograph is never priced under an emoji (a lone modifier or regional indicator before it, anywhere in the text)', () => {
  it('a cluster that starts with one costs at least the emoji width (production: "tone, space, heart" 32.78px)', () => {
    for (const cp of [0x2695, 0x2764, 0x26a0, 0x25b6, 0x2640, 0x263a, 0x2714]) expect(cost(cp), cp.toString(16)).toBe(emoji);
    expect(px('\u{1F3FD}\u2695')).toBeGreaterThanOrEqual(29.95);
    expect(px('\u{1F3FD} \u2764')).toBeGreaterThanOrEqual(32.78);
    expect(px('\u{1F1E6}1\u2695')).toBeGreaterThanOrEqual(37.16);
    expect(px('\u{1F3FD}abc\u26A0')).toBeGreaterThanOrEqual(36.36);
  });

  it('only a cluster that starts with one: a letter before it is its own advance', () => {
    expect(cost(0x61, 0x2695)).toBe(adv(0x61) + adv(0x2695));
  });

  it('a pictograph the faces set (the copyright sign) and row labels keep their own advance', () => {
    expect(px('\u{1F3FD}\u00A9')).toBeLessThan(25);
    expect(fallbackClusterPx(S(0x2695), 'label400', 12, 12)).toBe(adv(0x2695));
  });
});

describe('a variation selector after a pictograph is free only as U+FE0F or U+FE0E (blind L2)', () => {
  it('VS1 to VS14 and the ideographic selectors cost the widest glyph on a pictograph, as on any base the table lacks', () => {
    for (const base of [0x2764, 0x26a0, 0x1f600, 0x2b06, 0x1f441]) {
      for (const selector of [0xfe00, 0xfe01, 0xfe0d, 0xe0100, 0xe01ef]) expect(cost(base, selector), `${base.toString(16)} ${selector.toString(16)}`).toBe(adv(base) + widest);
    }
  });
});

describe('a cluster with a ZWJ is priced from the fallback tables though the faces set it (page model and gate)', () => {
  it('the ruler and the gate price "digit ZWJ" as two emoji, not a digit', () => {
    expect(px('1\u200D')).toBe(2 * emoji);
    expect(boundPx('1\u200D\u{1F600}', 12)).toBeGreaterThanOrEqual(29.95);
    expect(boundPx('a\u200D', 12)).toBeGreaterThanOrEqual(2 * emoji);
  });

  it('the page model and the gate read every adversary cell at least as many lines as production (the widths above)', () => {
    for (const cell of [...ROUND7_JOINED, ...ROUND7_SKIN, ...ROUND7_TEXT_SELECTOR, ...ROUND7_CHAINS].filter((_, i) => i % 9 === 0)) {
      const text = cell.repeat(Math.ceil(400 / cell.length));
      for (const mm of [174, 110, 60]) expect(proseLinesBound(text, PROSE.narrativeBody, mm), `${JSON.stringify(cell)} at ${mm}mm`).toBeGreaterThanOrEqual(proseLines(text, PROSE.narrativeBody, mm));
    }
  }, 120_000);
});

describe('the mark gaps\' offset counts code points of the text (blind M1)', () => {
  const typed = (before: string): number => px(`${before} \u092F\u200C\u093C`);
  const deleted = (before: string): number => px(`${before} \u092F\u00AD\u093C`);

  it('an astral character before the soft hyphen and mark leaves it priced apart, as the typed joiner is', () => {
    expect(deleted('\u{1F600}')).toBe(typed('\u{1F600}'));
    expect(deleted('\u{1D49C}\u{1F600}')).toBe(typed('\u{1D49C}\u{1F600}'));
    expect(deleted('\u{1F600}')).toBeGreaterThan(px('\u{1F600} \u092F\u093C') + 50);
  });

  it('a cluster of several code points before it does too (a letter with two marks, a family)', () => {
    expect(deleted('e\u0301')).toBe(typed('e\u0301'));
    expect(deleted('a\u0301\u0323')).toBe(typed('a\u0301\u0323'));
    expect(deleted('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe(typed('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'));
  });
});
