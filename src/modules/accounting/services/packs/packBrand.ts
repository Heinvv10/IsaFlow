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
import { checkPublicUrl } from '@/lib/safeFetch';
import { log } from '@/lib/logger';
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

/**
 * THE LOGO, RE-CHECKED AT RENDER TIME — the same policy as `safePrimary`
 * above, applied to the one tenant-controlled URL the pack puts on the page.
 *
 * `brand-profile.ts` runs `checkPublicUrl` on the way IN, which is a
 * point-in-time DNS decision: a host that resolves publicly when the profile
 * is saved and privately when the pack is rendered is fetched by the headless
 * browser as `<img src>` on the cover. Under Gotenberg the container's
 * `--chromium-allow-list` is the outer bound; under the Playwright transport
 * (`PDF_TRANSPORT=playwright`, the documented incident fallback) there is no
 * equivalent, and its own request interceptor is scoped to the API paths the
 * print page fetches — it does not see image loads at all.
 *
 * SUBSTITUTE, DO NOT REFUSE. A logo that no longer resolves publicly is
 * dropped and the pack prints without it, exactly as an unreadable brand
 * colour is replaced rather than throwing: at render time there is no UI to
 * warn against, and a board pack that will not render is worse than one with
 * no logo on its cover. The reason is logged.
 *
 * Async, and therefore separate from `resolvePackBrand` rather than folded
 * into it: the resolver is pure and is called from tests and from any surface
 * that only wants the colours. Everything that hands a brand to the RENDERER
 * goes through this.
 */
export async function resolvePackBrandForRender(profile: BrandProfile | null): Promise<PackBrand> {
  const brand = resolvePackBrand(profile);
  if (brand.logoUrl === null) return brand;
  const reason = await checkPublicUrl(brand.logoUrl);
  if (reason === null) return brand;
  log.warn('Pack logo dropped: its URL is not a public target at render time', { reason }, 'packs');
  return { ...brand, logoUrl: null };
}
