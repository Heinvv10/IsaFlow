import { describe, expect, it } from 'vitest';
import { packBrandStyleBlock, resolvePackBrand } from '@/modules/accounting/services/packs/packBrand';
import { NEUTRAL_BRAND_PRIMARY } from '@/lib/brand/contrast';

const profile = {
  id: 'b1', companyId: 'c1', logoUrl: 'https://app.isaflow.co.za/logo.png',
  primaryColour: '#1a3a5c', secondaryColour: '#c8a86b',
  fontFamily: 'professional' as const, coverStyle: 'classic' as const,
  reportFooterText: 'Confidential', createdAt: '', updatedAt: '',
};

describe('resolvePackBrand', () => {
  it('falls back to the neutral default when a company has no profile', () => {
    const brand = resolvePackBrand(null);
    expect(brand.primaryColour).toBe(NEUTRAL_BRAND_PRIMARY);
    expect(brand.logoUrl).toBeNull();
  });

  it('picks white ink on a dark primary and dark ink on a light one', () => {
    expect(resolvePackBrand({ ...profile, primaryColour: '#1a3a5c' }).primaryInk).toBe('#ffffff');
    // #8c8c8c: relative luminance 0.2623 (in the (0.183, 0.30] band where
    // white text fails 4.5:1 but dark ink and the page-band floor both
    // clear). Measured: contrast to #ffffff = 3.363 (< 4.5, so white ink is
    // rejected; still >= 3, so the band itself stays visible on the page),
    // contrast to #1a1a1a = 5.176 (>= 4.5, so dark ink is chosen).
    const brand = resolvePackBrand({ ...profile, primaryColour: '#8c8c8c' });
    expect(brand.primaryInk).toBe('#1a1a1a');
    expect(brand.primaryColour).toBe('#8c8c8c');
  });

  it('keeps a mid-dark primary that clears both thresholds, unchanged, with white ink', () => {
    // #3d5a80: contrast to #ffffff = 7.065 (>= 4.5, clears MIN_TEXT_CONTRAST
    // and, since 7.065 >= 3, MIN_BAND_CONTRAST too) — the ordinary case of a
    // primary that needed no substitution at all.
    const brand = resolvePackBrand({ ...profile, primaryColour: '#3d5a80' });
    expect(brand.primaryColour).toBe('#3d5a80');
    expect(brand.primaryInk).toBe('#ffffff');
  });

  it('substitutes the neutral default for a legacy row that predates the contrast gate', () => {
    // Rows written before Task 4 were never validated. #fafafa passes the
    // text-contrast OR-check (dark ink on it is ~19:1) but fails
    // MIN_BAND_CONTRAST (contrast to #ffffff = 1.044) — the band itself
    // would be invisible on the printed page even though black text on it
    // would technically read fine.
    expect(resolvePackBrand({ ...profile, primaryColour: '#fafafa' }).primaryColour)
      .toBe(NEUTRAL_BRAND_PRIMARY);
  });
});

describe('packBrandStyleBlock', () => {
  it('emits only custom-property declarations', () => {
    const css = packBrandStyleBlock(resolvePackBrand(profile));
    expect(css).toContain('--pack-brand: #1a3a5c');
    expect(css).toContain('--pack-brand-ink: #ffffff');
    expect(css.match(/[{}]/g)?.length).toBe(2);
  });

  it('refuses a colour that is not a plain hex triplet', () => {
    // The value reaches a <style> block, so anything but #rrggbb is an
    // injection surface, not a styling question.
    expect(() => packBrandStyleBlock({
      ...resolvePackBrand(profile),
      primaryColour: 'red; } body { display: none } :root {',
    })).toThrow();
  });
});
