/**
 * WHAT A MARK, A SELECTOR AND A JOINED PICTOGRAPH COST WHERE THE TABLES DID NOT MEASURE THEM (#1264, round 6 of #1263).
 * Three more classes of the same hole, each closed by a conservative rule and held here on GitHub (the image test,
 * `printParity/packProseMarksR6Image.test.ts`, is velo-only):
 *  - H1 a mark after a character the ruler deletes (soft hyphen, zero-width space, word joiner, bidi controls) was priced
 *    as on its base, because the deletion joined them into one cluster; production sets it apart, on a dotted circle;
 *  - H2 a variation selector after a base the faces lack (U+022E, U+109E, ...) was priced as free; production sets base
 *    and selector in another face, wider. A selector is measured only on the letters of ANY_BASES;
 *  - H3 an emoji ZWJ sequence that is not one emoji (a heart joined to a heart) was priced as one glyph; production draws
 *    its components. A joined cluster costs the sum of its components' emoji widths.
 * Round-6 blind L1: the round-4 "larger of in a word and elsewhere" for a mark after a mark.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK_MARKS } from '@/modules/accounting/services/packs/pages/packFallbackMarkData';
import { SCRIPT_NAMES, SCRIPT_RANGES } from '@/modules/accounting/services/packs/pages/packFallbackScriptData';
import { FALLBACK } from '@/modules/accounting/services/packs/pages/packFallbackWidthData';
import { fallbackAdvancePx, fallbackClusterPx } from '@/modules/accounting/services/packs/pages/packFallbackWidth';
import { textExactPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { asShaped, withGaps } from '@/modules/accounting/services/packs/pages/packGlyphShaping';
import { proseLinesBound } from '@/modules/accounting/services/packs/pages/packProseBound';
import { proseLines } from '@/modules/accounting/services/packs/pages/packProseLines';
import { PROSE } from '@/modules/accounting/services/packs/pages/packProseStyles';
import { ROUND6_EMOJI, ROUND6_IGNORABLES, ROUND6_NAMED, ROUND6_SELECTORS } from '../../print/fixtures/adversaryRound6Texts';

const widest = FALLBACK.label400.widest;
const emoji = FALLBACK.label400.emoji;
const ZWJ = 0x200d;
const VS1 = 0xfe00;
const VS16 = 0xfe0f;
const cost = (...cps: number[]): number => fallbackClusterPx(String.fromCodePoint(...cps), 'label400', 12, 12, true);
const adv = (cp: number): number => fallbackAdvancePx(cp, 'label400');
const inWord = (cp: number): number => FALLBACK_MARKS.find((row) => row[0] === cp)![1];
const elsewhere = (cp: number): number => FALLBACK_MARKS.find((row) => row[0] === cp)![2];
/** A prose text's width as the ruler prices it, marks as production sets them. */
const px = (text: string): number => textExactPx(text, 12, 400, false, true);

describe('a mark after a character the ruler deletes costs the widest glyph (H1)', () => {
  it('asShaped reports the mark a deleted run stood in front of, and only that', () => {
    const gaps = new Set<number>();
    expect(asShaped('a\u00AD\u093Cb\u200Bc\u2060\u2061d', gaps)).toBe('a\u093Cbcd');
    expect([...gaps]).toEqual([1]);
    const mid = new Set<number>();
    asShaped('\u092F\u093C\u202C\u0900', mid);
    expect([...mid]).toEqual([2]);
    const none = new Set<number>();
    asShaped('1\u00AD2 \u00AD\u200B', none);
    expect([...none]).toEqual([]);
    // A run kept as one zero-width space (between digits) is a character of the result: offsets count it.
    const kept = new Set<number>();
    expect(asShaped('1\u00AD2\u00AD\u0301', kept)).toBe('1\u200B2\u0301');
    expect([...kept]).toEqual([3]);
  });

  it('withGaps puts a joiner back before such a mark, never at the cluster start', () => {
    expect(withGaps('\u092F\u093C\u0900', 4, new Set([5]))).toBe('\u092F\u200C\u093C\u0900');
    expect(withGaps('\u093C\u0900', 4, new Set([4]))).toBe('\u093C\u0900');
  });

  it('every one of the 14, between a base and a mark of the fallback faces, costs what the joiner already did', () => {
    for (const [base, mark] of [[0x92f, 0x93c], [0x7db, 0x7eb], [0x1780, 0x17b6], [0x995, 0x9bc], [0xe9a, 0xecd], [0x1000, 0x102d]] as const) {
      const apart = px(String.fromCodePoint(base, 0x200c, mark));
      expect(apart, 'the joiner version is the dotted-circle price').toBeGreaterThan(px(String.fromCodePoint(base, mark)));
      for (const z of ROUND6_IGNORABLES) {
        expect(px(String.fromCodePoint(base, z, mark)), `${base.toString(16)} ${z.toString(16)} ${mark.toString(16)}`).toBe(apart);
      }
    }
  });

  it('a second mark, a selector, and a mark across two deleted characters are set apart too', () => {
    const joined = px('\u092F\u093C\u200C\u0900');
    expect(px('\u092F\u093C\u00AD\u0900')).toBe(joined);
    expect(px('\u092F\u00AD\u200B\u093C')).toBe(px('\u092F\u200C\u093C'));
    expect(px('\u092F\u00AD\uFE00')).toBe(px('\u092F\u200C\uFE00'));
  });

  it('leaves what is not a mark after it, and text the faces set, as they were', () => {
    expect(px('\u092F\u00ADa')).toBe(px('\u092Fa'));
    expect(px('e\u00AD\u0301')).toBe(px('e\u0301'));
    expect(px('a\u200B\u0301b')).toBe(px('a\u0301b'));
    expect(px('1\u00AD2')).toBe(px('12'));
  });

  it('page model lines and the gate: a text of such cells never reads fewer lines than the same with a joiner', () => {
    for (const cell of ROUND6_NAMED.slice(0, 7)) {
      const text = cell.repeat(Math.ceil(600 / cell.length));
      const joiner = text.replace(/[\u00AD\u200B\u200E\u202A\u202C\u2060-\u2064\u2066\u2069\u206A\u206F]/gu, '\u200C');
      for (const mm of [174, 110, 60]) {
        expect(proseLines(text, PROSE.narrativeBody, mm), `${JSON.stringify(cell)} at ${mm}`).toBe(proseLines(joiner, PROSE.narrativeBody, mm));
        expect(proseLinesBound(text, PROSE.narrativeBody, mm)).toBeGreaterThanOrEqual(proseLines(text, PROSE.narrativeBody, mm));
      }
    }
  });
});

describe('a selector is measured only on the letters it was measured on (H2)', () => {
  it('on a base the faces lack it costs the widest glyph, of every kind', () => {
    for (const base of [0x22e, 0x4ea, 0x109e, 0x1e27, 0x1e0b, 0x1fe0, 0x1e7b]) {
      for (const selector of [VS1, 0xfe01, 0xfe0e, 0xe0100, 0xe01ef]) {
        expect(cost(base, selector), `${base.toString(16)} ${selector.toString(16)}`).toBe(adv(base) + widest);
      }
    }
  });

  it('on a letter of ANY_BASES it is what the table measured', () => {
    for (const base of [0x61, 0x5a, 0x1000, 0x1780, 0x915]) expect(cost(base, VS1)).toBe(adv(base) + inWord(VS1));
  });

  it('but a selector right after a pictograph is one emoji: the emoji width, not the widest glyph', () => {
    for (const base of [0x2764, 0x26a0, 0x2705, 0x2714, 0x2611, 0x260e, 0x2709, 0x270f, 0x25b6, 0x2b06, 0x2197, 0xa9, 0xae, 0x2122, 0x2139, 0x2600, 0x2601, 0x1f600, 0x1f441]) {
      expect(cost(base, VS16), base.toString(16)).toBe(Math.max(emoji, adv(base) + inWord(VS16)));
      expect(cost(base, VS16)).toBeLessThan(adv(base) + widest);
      // Round 7 (#1264): a text selector after a pictograph is not free (U+1F634 U+FE0E is 19px): the sequence rule.
      expect(cost(base, 0xfe0e), base.toString(16)).toBe(Math.max(emoji, adv(base)) + emoji);
    }
  });

  it('the exemption is the pictograph\'s only: a letter or a plain symbol keeps the widest glyph (a digit is a keycap, round 7)', () => {
    for (const base of [0x22e, 0x109e, 0x2b, 0x4e2d]) expect(cost(base, VS16), base.toString(16)).toBe(adv(base) + widest);
    // and a selector after a pictograph and another selector, or a mark, is still across a stack
    expect(cost(0x2764, VS16, VS16)).toBeGreaterThanOrEqual(adv(0x2764) + widest);
    expect(cost(0x2764, 0x301, VS16)).toBeGreaterThanOrEqual(adv(0x2764) + widest);
  });

  it('every text of the sweep is priced at least a selector\'s widest glyph over its base, in lines', () => {
    for (const cell of ROUND6_SELECTORS.filter((_, i) => i % 7 === 0)) {
      const base = String.fromCodePoint(cell.codePointAt(0)!);
      const text = cell.repeat(Math.ceil(600 / cell.length));
      expect(proseLines(text, PROSE.narrativeBody, 60), JSON.stringify(cell)).toBeGreaterThan(proseLines(base.repeat(300) + ' ', PROSE.narrativeBody, 60) - 1);
      expect(proseLinesBound(text, PROSE.narrativeBody, 60)).toBeGreaterThanOrEqual(proseLines(text, PROSE.narrativeBody, 60));
    }
  });
});

describe('a ZWJ sequence of pictographs costs the sum of its components (H3)', () => {
  const part = (cp: number): number => Math.max(adv(cp), emoji);

  it('a heart joined to a heart, a face to a sign: each component an emoji', () => {
    // Round 7 (#1264): the joiner itself counts at an emoji, too (the sum is over every code point).
    expect(cost(0x2764, ZWJ, 0x2764, ZWJ, 0x2764)).toBe(5 * part(0x2764));
    expect(cost(0x2764, VS16, ZWJ, 0x2764, VS16)).toBeGreaterThanOrEqual(2 * part(0x2764));
    expect(cost(0x1f600, ZWJ, 0x2640)).toBe(part(0x1f600) + emoji + part(0x2640));
    expect(cost(0x263a, ZWJ, 0x2640)).toBe(part(0x263a) + emoji + part(0x2640));
    expect(cost(0x1f468, ZWJ, 0x2640)).toBe(part(0x1f468) + emoji + part(0x2640));
    // With a VS16 on the sign: its selector costs the widest glyph too (H2), on top of the components.
    for (const head of [0x1f600, 0x263a, 0x1f468, 0x1f3f3, 0x1f441]) expect(cost(head, ZWJ, 0x2640, VS16)).toBeGreaterThanOrEqual(part(head) + part(0x2640));
  });

  it('is never less than what the cluster cost before (the heart on fire, the eye in a speech bubble)', () => {
    expect(cost(0x2764, VS16, ZWJ, 0x1f525)).toBeGreaterThanOrEqual(Math.max(emoji, adv(0x2764) + adv(0x1f525)));
    expect(cost(0x1f441, VS16, ZWJ, 0x1f5e8, VS16)).toBeGreaterThanOrEqual(2 * emoji);
  });

  it('one pictograph and a joiner, or a joiner in a script, is a sequence too (round 7: any cluster holding a ZWJ)', () => {
    expect(cost(0x1f600, ZWJ)).toBe(part(0x1f600) + emoji);
    expect(cost(0x915, 0x94d, ZWJ, 0x937)).toBe(part(0x915) + part(0x94d) + emoji + part(0x937));
  });

  it('row labels keep the tables\' reading (marks off)', () => {
    expect(fallbackClusterPx(String.fromCodePoint(0x2764, ZWJ, 0x2764, ZWJ, 0x2764), 'label400', 12, 12)).toBe(3 * adv(0x2764));
  });

  it('the gate bounds the model on every emoji text of the sweep', () => {
    for (const cell of ROUND6_EMOJI) {
      const text = cell.repeat(Math.ceil(300 / cell.length));
      for (const mm of [174, 110, 60]) {
        expect(proseLinesBound(text, PROSE.narrativeBody, mm), `${JSON.stringify(cell)} at ${mm}mm`).toBeGreaterThanOrEqual(proseLines(text, PROSE.narrativeBody, mm));
      }
    }
  }, 120_000);
});

describe('a mark after a mark costs the larger of what it adds in a word and elsewhere, and at least an em (blind L1)', () => {
  /** Marks of a script whose "elsewhere" is more than both its "in a word" and an em, with a base and a first mark of the script. */
  const cases = FALLBACK_MARKS.flatMap(([second, word, other, script]) => {
    if (SCRIPT_NAMES[script] === 'Common' || SCRIPT_NAMES[script] === 'Inherited' || other <= Math.max(word, 12)) return [];
    const range = SCRIPT_RANGES.find((r) => r[2] === script);
    const first = FALLBACK_MARKS.find((row) => row[3] === script && row[0] !== second && row[1] <= 12);
    return range === undefined || first === undefined ? [] : [{ base: range[0], first: first[0], second }];
  });

  it('there are such marks (Oriya U+0B03 after a nukta: 6 in a word, 16 elsewhere)', () => {
    expect(cases.length).toBeGreaterThan(50);
    expect(cases.some((c) => c.second === 0xb03)).toBe(true);
  });

  it('prices each at its elsewhere value, not the in-word value the em floor would hide', () => {
    for (const { base, first, second } of cases) {
      expect(cost(base, first, second), `${base.toString(16)} ${first.toString(16)} ${second.toString(16)}`)
        .toBeGreaterThanOrEqual(adv(base) + inWord(first) + elsewhere(second));
    }
  });
});
