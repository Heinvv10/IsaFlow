/**
 * THE LOGO, RE-CHECKED AT RENDER TIME — the same policy as `safePrimary` in
 * `packBrand.ts`, applied to the one tenant-controlled URL the pack puts on
 * the page.
 *
 * `brand-profile.ts` runs `checkPublicUrl` on the way IN, which is a
 * point-in-time DNS decision: a host that resolves publicly when the profile
 * is saved and privately when the pack is rendered is fetched by the headless
 * browser as `<img src>` on the cover. Under Gotenberg the container's
 * pinning proxy refuses it by URL — measured, see `src/lib/pdf/selectTransport.ts`
 * — but under the Playwright transport (`PDF_TRANSPORT=playwright`, the
 * documented incident fallback) there is no equivalent: its request
 * interception is scoped to the API paths the print page fetches and never
 * sees an image load.
 *
 * SUBSTITUTE, DO NOT REFUSE. A logo that no longer resolves publicly is
 * dropped and the pack prints without it, exactly as an unreadable brand
 * colour is replaced rather than throwing: at render time there is no UI to
 * warn against, and a board pack that will not render is worse than one with
 * no logo on its cover. The reason is logged.
 *
 * ITS OWN FILE, AND THAT IS THE POINT. `safeFetch` imports `node:dns`, and
 * `packBrand.ts` is imported by `PackPagesView.tsx` — so putting this beside
 * the resolver put `node:dns/promises` in the browser bundle and the print
 * page 500'd on a webpack `UnhandledSchemeError`. Nothing client-side imports
 * this module.
 */
import type { BrandProfile } from '@/modules/accounting/services/afs/afsTypes';
import { checkPublicUrl } from '@/lib/safeFetch';
import { log } from '@/lib/logger';
import { resolvePackBrand, type PackBrand } from './packBrand';

export async function resolvePackBrandForRender(profile: BrandProfile | null): Promise<PackBrand> {
  const brand = resolvePackBrand(profile);
  if (brand.logoUrl === null) return brand;
  const reason = await checkPublicUrl(brand.logoUrl);
  if (reason === null) return brand;
  log.warn('Pack logo dropped: its URL is not a public target at render time', { reason }, 'packs');
  return { ...brand, logoUrl: null };
}
