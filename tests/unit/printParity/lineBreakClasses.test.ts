/**
 * THE LINE-BREAK CLASS TABLES (`lineBreakClasses.ts`): each committed table checked for order and shape; with
 * LINE_BREAK_TXT set to Unicode's LineBreak.txt, the letters written afresh.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NUMERIC_CLASS_RANGES } from '@/modules/accounting/services/packs/pages/packNumericClassData';
import { LETTER_RANGES } from '../print/fixtures/lineBreakLetterData';
import { DICTIONARY_BREAK_RANGES } from '@/modules/accounting/services/packs/pages/packDictionaryBreakData';
import { dictionarySource, letterSource, NUMERIC_CLASSES, parseLineBreak, variationBases, variationBaseSource } from './lineBreakClasses';

const ROOT = path.resolve(__dirname, '../../..');

describe('the line-break class tables', () => {
  it.each([['numeric', NUMERIC_CLASS_RANGES, NUMERIC_CLASSES.length], ['letters', LETTER_RANGES, 2]] as const)('%s: runs in order, apart, each of a known class', (unused, runs, classes) => {
    expect(runs.length).toBeGreaterThan(100);
    runs.forEach(([from, to, cls], i) => {
      expect(from).toBeLessThanOrEqual(to);
      expect(cls).toBeLessThan(classes);
      if (i > 0) expect(from).toBeGreaterThan(runs[i - 1]![1]);
    });
  });

  it.skipIf(process.env.EMOJI_VARIATION_TXT === undefined)('EMOJI_VARIATION_TXT: writes the emoji variation bases', () => {
    writeFileSync(path.join(ROOT, 'tests/unit/print/fixtures/emojiVariationBases.ts'), variationBaseSource(variationBases(readFileSync(process.env.EMOJI_VARIATION_TXT!, 'utf8'))));
  });

  it.skipIf(process.env.LINE_BREAK_TXT === undefined)('LINE_BREAK_TXT: writes the letters from LineBreak.txt (the numeric classes are the image test\'s)', () => {
    const classes = parseLineBreak(readFileSync(process.env.LINE_BREAK_TXT!, 'utf8'));
    writeFileSync(path.join(ROOT, 'tests/unit/print/fixtures/lineBreakLetterData.ts'), letterSource(classes));
    writeFileSync(path.join(ROOT, 'src/modules/accounting/services/packs/pages/packDictionaryBreakData.ts'), dictionarySource(classes));
  });

  it('the dictionary-break (SA) runs: in order, apart, and the four scripts the pack has met are in them', () => {
    expect(DICTIONARY_BREAK_RANGES.length).toBeGreaterThan(20);
    DICTIONARY_BREAK_RANGES.forEach(([from, to], i) => {
      expect(from).toBeLessThanOrEqual(to);
      if (i > 0) expect(from).toBeGreaterThan(DICTIONARY_BREAK_RANGES[i - 1]![1] + 1);
    });
    const covered = (cp: number): boolean => DICTIONARY_BREAK_RANGES.some(([a, b]) => cp >= a && cp <= b);
    expect([0x0e01, 0x0e81, 0x1000, 0x103a, 0x1780, 0x17d2].every(covered)).toBe(true);
    expect([0x41, 0x4e00, 0xac00, 0x0915].some(covered)).toBe(false);
  });
});
