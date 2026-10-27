/**
 * Invitation links carry a bearer secret: `/invite/<token>`, `/accept-invite?token=`,
 * `/login?invite=<token>&returnTo=/invite/<token>`, `/register?invite=`. Holding one
 * is enough to set the first password of an address that has no login yet, so none
 * may be written to `analytics_events`, which anyone with analytics access reads.
 *
 * Scrubbed on ingest, not by skipping the tracker on those pages: once
 * public/isa-track.js has loaded it reports every later history change and the
 * page's `document.referrer`, so a client-side exclusion leaks through the next
 * navigation. (/share/<token> is kept off the page entirely; see isTrackedPath.)
 */

const SECRET_PARAMS = new Set(['token', 'invite']);
const REDACTED = '[redacted]';

/** `/invite/<anything>` -> `/invite/[token]`; every other path unchanged. */
export function scrubInvitePath(path: string): string {
  return path === '/invite' || path.startsWith('/invite/') ? '/invite/[token]' : path;
}

/** A query string (no leading `?`) with token/invite values and invite return paths redacted. */
export function scrubInviteQuery(query: string | null): string | null {
  if (!query) return query;
  const params = new URLSearchParams(query);
  let changed = false;
  for (const [key, value] of [...params]) {
    const scrubbed = SECRET_PARAMS.has(key.toLowerCase()) ? REDACTED : scrubInvitePath(value);
    if (scrubbed !== value) { params.set(key, scrubbed); changed = true; }
  }
  // Untouched queries keep their exact encoding.
  return changed ? params.toString() : query;
}

/** A full referrer URL scrubbed the same way; dropped if it cannot be parsed. */
export function scrubInviteReferrer(referrer: string | null): string | null {
  if (!referrer) return referrer;
  let url: URL;
  try { url = new URL(referrer); } catch { return null; }
  url.pathname = scrubInvitePath(url.pathname);
  url.search = scrubInviteQuery(url.search.slice(1)) ?? '';
  url.hash = '';
  return url.toString();
}
