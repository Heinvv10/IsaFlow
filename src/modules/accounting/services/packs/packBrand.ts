/**
 * The brand tokens a printed pack renders with.
 *
 * Two things this file exists to stop. First, a company with no brand_profiles
 * row printing an unstyled pack — it gets the neutral default instead. Second,
 * a legacy row written before the contrast gate (Task 4) reproducing an
 * unreadable cover: the resolver re-checks and substitutes rather than trusting
 * the stored value.
 */
import type { BrandProfile } from '@/modules/accounting/services/afs/afsTypes';
import { NEUTRAL_BRAND_PRIMARY, contrastRatio } from '@/lib/brand/contrast';

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface PackBrand {
  primaryColour: string;
  secondaryColour: string;
  logoUrl: string | null;
  footerText: string | null;
  /** '#ffffff' or '#1a1a1a', whichever reads on primaryColour. */
  primaryInk: string;
}

/** WCAG 2.1 AA, success criterion 1.4.3 (contrast minimum). The primary must
 *  carry white OR near-black text at this ratio; `primaryInk` picks whichever
 *  of the two wins. */
const MIN_TEXT_CONTRAST = 4.5;

/** WCAG 2.1 AA, success criterion 1.4.11 (non-text contrast). The primary
 *  must be distinguishable from the white page at this ratio, or the cover
 *  band, divider bands and table header rows are invisible on paper — a
 *  colour can clear MIN_TEXT_CONTRAST against dark ink while still failing
 *  this (e.g. a near-white primary reads fine in black text, but the band
 *  itself vanishes into the page). */
const MIN_BAND_CONTRAST = 3;

function safePrimary(value: string): string {
  if (!HEX.test(value)) return NEUTRAL_BRAND_PRIMARY;
  const contrastToWhite = contrastRatio(value, '#ffffff');
  const carriesText = contrastToWhite >= MIN_TEXT_CONTRAST || contrastRatio(value, '#1a1a1a') >= MIN_TEXT_CONTRAST;
  const visibleOnPage = contrastToWhite >= MIN_BAND_CONTRAST;
  return carriesText && visibleOnPage ? value : NEUTRAL_BRAND_PRIMARY;
}

export function resolvePackBrand(profile: BrandProfile | null): PackBrand {
  const primaryColour = safePrimary(profile?.primaryColour ?? NEUTRAL_BRAND_PRIMARY);
  const secondaryColour = HEX.test(profile?.secondaryColour ?? '') ? profile!.secondaryColour : '#c8a86b';
  return {
    primaryColour,
    secondaryColour,
    logoUrl: profile?.logoUrl ?? null,
    footerText: profile?.reportFooterText ?? null,
    primaryInk: contrastRatio(primaryColour, '#ffffff') >= MIN_TEXT_CONTRAST ? '#ffffff' : '#1a1a1a',
  };
}

export function packBrandStyleBlock(brand: PackBrand): string {
  for (const [field, value] of [
    ['primaryColour', brand.primaryColour], ['secondaryColour', brand.secondaryColour],
    ['primaryInk', brand.primaryInk],
  ] as const) {
    if (!HEX.test(value)) throw new Error(`packBrandStyleBlock: ${field} is not a hex colour`);
  }
  return `html.print-mode {\n` +
    `  --pack-brand: ${brand.primaryColour};\n` +
    `  --pack-brand-secondary: ${brand.secondaryColour};\n` +
    `  --pack-brand-ink: ${brand.primaryInk};\n` +
    `}`;
}
