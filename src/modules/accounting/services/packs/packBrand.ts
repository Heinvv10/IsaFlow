/**
 * The brand tokens a printed pack renders with.
 *
 * PURE, AND IT HAS TO STAY THAT WAY: `PackPagesView.tsx` imports
 * `packBrandStyleBlock` from here, so everything this module imports is in the
 * BROWSER bundle. The render-time SSRF re-check of `logoUrl` needs
 * `node:dns`, so it lives in `packBrandForRender.ts` — importing `safeFetch`
 * here broke the print page with `UnhandledSchemeError: Reading from
 * "node:dns/promises"`, which every unit test was green over and only loading
 * the page showed.
 *
 * Two things this file exists to stop. First, a company with no brand_profiles
 * row printing an unstyled pack — it gets the neutral default instead. Second,
 * a legacy row written before the contrast gate (Task 4) reproducing an
 * unreadable cover: the resolver re-checks and substitutes rather than trusting
 * the stored value.
 */
import type { BrandProfile } from '@/modules/accounting/services/afs/afsTypes';
import {
  DARK_INK, MIN_TEXT_CONTRAST, NEUTRAL_BRAND_PRIMARY, contrastRatio, isUsableBrandPrimary,
} from '@/lib/brand/contrast';

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface PackBrand {
  primaryColour: string;
  secondaryColour: string;
  logoUrl: string | null;
  footerText: string | null;
  /** '#ffffff' or '#1a1a1a', whichever reads on primaryColour. */
  primaryInk: string;
}

/** The RENDER gate. A legacy row written before the save gate can still hold a
 *  colour that prints an unreadable cover, so the resolver re-checks and
 *  substitutes rather than trusting the stored value. It substitutes rather
 *  than throwing on purpose: at render time there is no UI to warn against, and
 *  refusing to render is worse than rendering in the neutral brand. */
function safePrimary(value: string): string {
  if (!HEX.test(value)) return NEUTRAL_BRAND_PRIMARY;
  return isUsableBrandPrimary(value) ? value : NEUTRAL_BRAND_PRIMARY;
}

export function resolvePackBrand(profile: BrandProfile | null): PackBrand {
  const primaryColour = safePrimary(profile?.primaryColour ?? NEUTRAL_BRAND_PRIMARY);
  const secondaryColour = HEX.test(profile?.secondaryColour ?? '') ? profile!.secondaryColour : '#c8a86b';
  return {
    primaryColour,
    secondaryColour,
    logoUrl: profile?.logoUrl ?? null,
    footerText: profile?.reportFooterText ?? null,
    primaryInk: contrastRatio(primaryColour, '#ffffff') >= MIN_TEXT_CONTRAST ? '#ffffff' : DARK_INK,
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
