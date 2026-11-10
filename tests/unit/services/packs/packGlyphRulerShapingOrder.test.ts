/**
 * THE RULER SETS A RUN THE SAME WHATEVER IT SHAPED BEFORE.
 *
 * fontkit keeps one glyph object per glyph id, with the code points it was first made for: shaping "½" (which
 * the face's ccmp breaks into one, the fraction slash and two) makes the slash's glyph stand for no code point, and
 * fontkit's fraction rule, which looks for U+2044, then no longer saw "1⁄2" as a fraction. This file runs in a
 * module of its own, so "½" is the first thing its ruler shapes. The widths are print Chromium's, measured by
 * `tests/unit/print/packGlyphRuler.test.ts` (12px, weight 400).
 */
import { describe, expect, it } from 'vitest';
import { AS_CHROMIUM_SETS, runPx } from '@/modules/accounting/services/packs/pages/packGlyphRuler';

const fails = (cluster: string): number => { throw new Error(`not in the face: ${cluster}`); };
const units = (text: string): number => runPx(text, 12, 400, fails, 0, false, AS_CHROMIUM_SETS) * 64;

describe('after a run whose substitutions made the fraction slash\'s glyph', () => {
  it('a slash between two digits is still a fraction, and one with a digit on one side only is not', () => {
    expect(units('a 7½')).toBeGreaterThan(0);
    expect(units('a 1⁄2')).toBe(1262);
    expect(units('a ⁄1')).toBe(1166);
  });
});
