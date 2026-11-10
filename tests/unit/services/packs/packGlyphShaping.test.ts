/**
 * WHAT FONTKIT IS HANDED (`packGlyphShaping.ts`): the text as HarfBuzz reads it, before what Chromium sets as nothing is
 * taken out. The widths these make are held to print Chromium by `tests/unit/print/packGlyphRuler.test.ts`; this pins
 * the hand-over itself, without a browser.
 */
import { describe, expect, it } from 'vitest';
import { fontsDir, loadFace } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { asShaped, shapingInput } from '@/modules/accounting/services/packs/pages/packGlyphShaping';

describe('asShaped', () => {
  it('what Chromium sets as nothing goes, but beside a fraction slash or between two digits it stays one zero-width space, where a fraction, numerator or denominator stops', () => {
    expect(asShaped('a 1\u20442')).toBe('a 1\u20442');
    expect(asShaped('a 1\u00AD\u20442')).toBe('a 1\u200B\u20442');
    expect(asShaped('a 1\u2044\u200B2')).toBe('a 1\u2044\u200B2');
    expect(asShaped('a 11\u00AD\u20601\u204422')).toBe('a 11\u200B1\u204422');
    expect(asShaped('A\u2060V\u00ADx\u200E')).toBe('AVx');
    expect(asShaped('Q1\u20282')).toBe('Q1 2');
  });

  it('a private-use character means only itself (no code point a tenant can type stands for a slash)', () => {
    expect(asShaped('Net\uE044profit')).toBe('Net\uE044profit');
  });
});

describe('shapingInput', () => {
  const face = loadFace(fontsDir(), 400);

  it('gives every glyph its own code point, and a slash without a digit on each side none', () => {
    const glyphs = shapingInput(face, '1\u20442 \u20443 1\u200B\u20442');
    expect(Array.isArray(glyphs)).toBe(true);
    if (!Array.isArray(glyphs)) return;
    expect(glyphs.map((g) => g.codePoints)).toEqual([[0x31], [0x2044], [0x32], [0x20], [], [0x33], [0x20], [0x31], [0x200b], [], [0x32]]);
  });

  it('leaves a run whose glyphs are not one a code point (fontkit folds a variation selector into the glyph before it) to fontkit\'s own mapping', () => {
    expect(shapingInput(face, '1\uFE0E\u20442')).toBe('1\uFE0E\u20442');
  });
});
