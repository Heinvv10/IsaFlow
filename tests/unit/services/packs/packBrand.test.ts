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
    expect(resolvePackBrand({ ...profile, primaryColour: '#e8c86b' }).primaryInk).toBe('#1a1a1a');
  });

  it('substitutes the neutral default for a legacy row that predates the contrast gate', () => {
    // Rows written before Task 4 were never validated. A render must not
    // reproduce an unreadable cover just because the row exists.
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
