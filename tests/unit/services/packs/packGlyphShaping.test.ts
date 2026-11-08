/**
 * WHAT FONTKIT IS HANDED (`packGlyphShaping.ts`): the text as HarfBuzz reads it, before what Chromium sets as nothing is
 * taken out. The widths these make are held to print Chromium by `tests/unit/print/packGlyphRuler.test.ts`; this pins
 * the hand-over itself, without a browser.
 */
import { describe, expect, it } from 'vitest';
import { fontsDir, loadFace } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { asShaped, LONE_SLASH, shapingInput } from '@/modules/accounting/services/packs/pages/packGlyphShaping';

describe('asShaped', () => {
  it('a fraction slash is decided on the text as given: one with a soft hyphen, a zero-width space or a word joiner beside it makes no fraction', () => {
    expect(asShaped('a 1⁄2')).toBe('a 1⁄2');
    expect(asShaped('a 1­⁄2')).toBe(`a 1${LONE_SLASH}2`);
    expect(asShaped('a 1⁄​2')).toBe(`a 1${LONE_SLASH}2`);
    expect(asShaped('a ⁄1')).toBe(`a ${LONE_SLASH}1`);
  });

  it('what Chromium sets as nothing goes, but between two digits it stays one zero-width space, where a numerator or denominator stops', () => {
    expect(asShaped('A⁠V­x‎')).toBe('AVx');
    expect(asShaped('a 11­⁠1⁄22')).toBe('a 11​1⁄22');
    expect(asShaped('a 1⁄​2')).toBe(`a 1${LONE_SLASH}2`);
    expect(asShaped('Q1 2')).toBe('Q1 2');
  });
});

describe('shapingInput', () => {
  const face = loadFace(fontsDir(), 400);

  it('gives every glyph its own code point, and a lone slash none', () => {
    const glyphs = shapingInput(face, `1⁄2 ${LONE_SLASH}3`);
    expect(Array.isArray(glyphs)).toBe(true);
    if (!Array.isArray(glyphs)) return;
    expect(glyphs.map((g) => g.codePoints)).toEqual([[0x31], [0x2044], [0x32], [0x20], [], [0x33]]);
    expect(glyphs[4]!.id).toBe(face.glyphForCodePoint(0x2044).id);
  });

  it('leaves a run whose glyphs are not one a code point (fontkit folds a variation selector into the glyph before it) to fontkit\'s own mapping', () => {
    expect(shapingInput(face, '1︎⁄2')).toBe('1︎⁄2');
  });
});
