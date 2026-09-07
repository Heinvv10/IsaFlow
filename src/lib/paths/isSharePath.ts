/**
 * Is this path the public share page?
 *
 * THE definition, for every gate that needs it. Three predicates for the same
 * question existed — the analytics tracker's, the service worker's, and the
 * one `_app.tsx` used for the service-worker registration — and three copies
 * of a security boundary is three chances for one of them to drift a segment.
 *
 * The boundary is the path SEGMENT, not the prefix: `/sharepoint` and
 * `/shared-with-me` are ordinary app pages and stay in. Takes Next's route
 * (`/share/[token]`) as readily as a resolved path, since that is what `_app`
 * holds.
 *
 * `public/sw.js` necessarily keeps its own copy — it is plain JS served to the
 * browser as a worker and cannot import from `src` — and says so in a comment
 * pointing back here. `tests/unit/lib/serviceWorkerShareCache.test.ts` runs
 * that copy against this one's cases.
 */
export function isSharePath(pathname: string): boolean {
  return pathname === '/share' || pathname.startsWith('/share/');
}
