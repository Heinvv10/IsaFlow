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

/**
 * Below this, a colour reads as indistinguishable from the white page itself
 * — the cover band vanishes even though the ink-contrast check below would
 * still pass (dark ink on near-white is high-contrast text on an invisible
 * band). This is a visibility floor, not a text-contrast rule, so it uses a
 * much lower bar than the 4.5:1 WCAG AA minimum.
 */
const MIN_CONTRAST_FROM_PAGE = 1.2;

function safePrimary(value: string): string {
  if (!HEX.test(value)) return NEUTRAL_BRAND_PRIMARY;
  const contrastToWhite = contrastRatio(value, '#ffffff');
  const carriesSomeInk = contrastToWhite >= 4.5 || contrastRatio(value, '#1a1a1a') >= 4.5;
  return carriesSomeInk && contrastToWhite >= MIN_CONTRAST_FROM_PAGE ? value : NEUTRAL_BRAND_PRIMARY;
}

export function resolvePackBrand(profile: BrandProfile | null): PackBrand {
  const primaryColour = safePrimary(profile?.primaryColour ?? NEUTRAL_BRAND_PRIMARY);
  const secondaryColour = HEX.test(profile?.secondaryColour ?? '') ? profile!.secondaryColour : '#c8a86b';
  return {
    primaryColour,
    secondaryColour,
    logoUrl: profile?.logoUrl ?? null,
    footerText: profile?.reportFooterText ?? null,
    primaryInk: contrastRatio(primaryColour, '#ffffff') >= 4.5 ? '#ffffff' : '#1a1a1a',
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
