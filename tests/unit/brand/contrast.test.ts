import { describe, expect, it } from 'vitest';
import {
  assertUsableBrandPrimary, brandPrimaryProblem, contrastRatio, isUsableBrandPrimary,
  relativeLuminance, BrandPrimaryError, DARK_INK, MIN_TEXT_CONTRAST, NEUTRAL_BRAND_PRIMARY,
} from '@/lib/brand/contrast';
import { resolvePackBrand } from '@/modules/accounting/services/packs/packBrand';
import type { BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('matches the WCAG worked example for mid grey', () => {
    // #808080 -> 0.2158 per the WCAG 2.1 relative-luminance definition.
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2158, 3);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#1a3a5c', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#1a3a5c'), 6);
  });
});

describe('brandPrimaryProblem', () => {
  it('passes the neutral default', () => {
    expect(brandPrimaryProblem(NEUTRAL_BRAND_PRIMARY)).toBeNull();
  });

  it('names the near-white failure as invisible-on-page, not illegible text', () => {
    // #f5f5f5 carries near-black text fine; what it cannot do is be seen as a
    // band on a white page (WCAG 1.4.11).
    expect(brandPrimaryProblem('#f5f5f5')).toBe('invisible-on-page');
  });

  it('names a mid-tone that carries neither ink as illegible-text', () => {
    // #7c7c7c is 4.17:1 both ways — under 4.5 against white AND against
    // near-black, so neither ink reads on it. The band would be visible; the
    // text on it would not be.
    expect(brandPrimaryProblem('#7c7c7c')).toBe('illegible-text');
  });

  it('accepts a colour exactly at the 4.5:1 threshold against white', () => {
    // #767676 on white is the canonical 4.54:1 boundary case.
    expect(brandPrimaryProblem('#767676')).toBeNull();
  });

  it('accepts a mid tone that carries near-black ink', () => {
    // #8c8c8c is 3.4:1 to white (band visible) and 5.2:1 to #1a1a1a.
    expect(brandPrimaryProblem('#8c8c8c')).toBeNull();
    expect(isUsableBrandPrimary('#8c8c8c')).toBe(true);
  });
});

describe('assertUsableBrandPrimary', () => {
  it('accepts the neutral default', () => {
    expect(() => assertUsableBrandPrimary(NEUTRAL_BRAND_PRIMARY, 'primaryColour')).not.toThrow();
  });

  it('rejects a near-white primary that would print an invisible band', () => {
    expect(() => assertUsableBrandPrimary('#f5f5f5', 'primaryColour')).toThrow(/primaryColour/);
  });

  it('throws a BrandPrimaryError carrying the machine-readable problem', () => {
    try {
      assertUsableBrandPrimary('#f5f5f5', 'primaryColour');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BrandPrimaryError);
      expect((err as BrandPrimaryError).problem).toBe('invisible-on-page');
    }
  });

  it('names the measured ratio so the message is actionable', () => {
    expect(() => assertUsableBrandPrimary('#f5f5f5', 'primaryColour'))
      .toThrow(/1\.\d+:1/);
  });
});

/**
 * The save gate and the render gate must be the SAME rule. They were not: the
 * save gate demanded white text at 4.5:1, while the renderer accepted white OR
 * near-black plus a visible band — so a mid tone was refused at save while the
 * renderer held a dark-ink branch no newly-saved row could reach.
 */
describe('the save gate and the render gate agree', () => {
  const profile = (primaryColour: string) =>
    ({ primaryColour, secondaryColour: '#c8a86b', logoUrl: null, reportFooterText: null }) as BrandProfile;

  const CASES = ['#8c8c8c', '#f5f5f5', '#7c7c7c', '#767676', '#1a3a5c', '#ffffff', '#000000'];

  for (const hex of CASES) {
    it(`${hex}: accepted at save iff rendered as itself`, () => {
      const acceptedAtSave = isUsableBrandPrimary(hex);
      const renderedAsItself = resolvePackBrand(profile(hex)).primaryColour === hex;
      expect(renderedAsItself).toBe(acceptedAtSave);
    });
  }

  it('the mid tone that exposed the disagreement is accepted by both', () => {
    expect(isUsableBrandPrimary('#8c8c8c')).toBe(true);
    expect(resolvePackBrand(profile('#8c8c8c')).primaryColour).toBe('#8c8c8c');
  });

  it('the renderer chooses its ink at the SAME threshold the gate reads', () => {
    // packBrand used to restate 4.5 for the ink choice, so raising the
    // threshold in contrast.ts would have left the renderer putting white text
    // on a colour the gate had just started refusing. Both sides now read
    // MIN_TEXT_CONTRAST, and this asserts against the constant rather than the
    // number so moving it moves the test with it.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(resolvePackBrand(profile('#767676')).primaryInk).toBe('#ffffff');

    expect(contrastRatio('#8c8c8c', '#ffffff')).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(resolvePackBrand(profile('#8c8c8c')).primaryInk).toBe(DARK_INK);
  });
});
