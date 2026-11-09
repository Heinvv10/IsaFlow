/**
 * THE LINE-BREAK CLASS TABLES (`lineBreakClasses.ts`): each committed table checked for order and shape; with
 * LINE_BREAK_TXT set to Unicode's LineBreak.txt, the letters written afresh.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NUMERIC_CLASS_RANGES } from '@/modules/accounting/services/packs/pages/packNumericClassData';
import { LETTER_RANGES } from '../print/fixtures/lineBreakLetterData';
import { letterSource, NUMERIC_CLASSES, parseLineBreak, variationBases, variationBaseSource } from './lineBreakClasses';

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
  });
});
