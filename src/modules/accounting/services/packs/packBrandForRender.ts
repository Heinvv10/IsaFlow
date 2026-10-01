/**
 * THE LOGO, FETCHED BY THE SERVER AND HANDED TO THE BROWSER AS BYTES — the
 * one tenant-controlled URL the pack puts on the page.
 *
 * `brand-profile.ts` runs `checkPublicUrl` on the way IN, which is a
 * point-in-time DNS decision. Checking again at compose time and then handing
 * the URL to the headless browser as `<img src>` is TWO resolutions of a name
 * the tenant controls — the check's and the browser's — so a host rebound to
 * an internal address between them was fetched from inside. Under Gotenberg
 * the container's pinning proxy refuses it by URL (measured, see
 * `src/lib/pdf/selectTransport.ts`); under the Playwright transport
 * (`PDF_TRANSPORT=playwright`, the documented incident fallback) there is no
 * equivalent: its request interception is scoped to the API paths the print
 * page fetches and never sees an image load.
 *
 * So the browser is never given the tenant's host. The server fetches the
 * logo ONCE through `safeFetch` — which validates the resolved addresses
 * immediately before fetching and refuses redirects — under a size cap, a
 * timeout and an image-type check, and the cover carries a `data:` URI. The
 * residual is the one `safeFetch` documents: a sub-second gap between its
 * lookup and the fetch's own resolution, closable only by a pinned-address
 * dispatcher this repo does not have. That is a far narrower window than the
 * browser's, and not a browser-reachable one.
 *
 * SUBSTITUTE, DO NOT REFUSE. A logo that cannot be fetched safely is dropped
 * and the pack prints without it, exactly as an unreadable brand colour is
 * replaced rather than throwing: at render time there is no UI to warn
 * against, and a board pack that will not render is worse than one with no
 * logo on its cover. The reason is logged.
 *
 * ITS OWN FILE, AND THAT IS THE POINT. `safeFetch` imports `node:dns`, and
 * `packBrand.ts` is imported by `PackPagesView.tsx` — so putting this beside
 * the resolver put `node:dns/promises` in the browser bundle and the print
 * page 500'd on a webpack `UnhandledSchemeError`. Nothing client-side imports
 * this module.
 */
import type { BrandProfile } from '@/modules/accounting/services/afs/afsTypes';
import { safeFetch } from '@/lib/safeFetch';
import { log } from '@/lib/logger';
import { resolvePackBrand, type PackBrand } from './packBrand';

export const LOGO_MAX_BYTES = 262_144;
export const LOGO_TIMEOUT_MS = 5_000;
/** Raster only. An SVG can carry script and references of its own, and a cover
 *  logo has no need of either. */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** The body, read until it ends, exceeds the cap, or the deadline passes. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('the response has no body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = setTimeout(() => { void reader.cancel(); }, LOGO_TIMEOUT_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LOGO_MAX_BYTES) {
        void reader.cancel();
        throw new Error(`the logo is larger than ${LOGO_MAX_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(deadline);
  }
  return Buffer.concat(chunks);
}

async function fetchLogoDataUri(url: string): Promise<string> {
  const res = await safeFetch(url, { headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' } },
    { timeoutMs: LOGO_TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!LOGO_TYPES.has(type)) throw new Error(`content type '${type}' is not a raster image`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > LOGO_MAX_BYTES) throw new Error(`the logo is larger than ${LOGO_MAX_BYTES} bytes`);
  const bytes = await readCapped(res);
  if (bytes.byteLength === 0) throw new Error('the logo is empty');
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

export async function resolvePackBrandForRender(profile: BrandProfile | null): Promise<PackBrand> {
  const brand = resolvePackBrand(profile);
  if (brand.logoUrl === null) return brand;
  try {
    return { ...brand, logoUrl: await fetchLogoDataUri(brand.logoUrl) };
  } catch (err) {
    log.warn('Pack logo dropped: it could not be fetched as a safe image at render time', {
      reason: err instanceof Error ? err.message : String(err),
    }, 'packs');
    return { ...brand, logoUrl: null };
  }
}
