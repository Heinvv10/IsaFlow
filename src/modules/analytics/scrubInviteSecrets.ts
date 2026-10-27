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
 *
 * Matched by the SECRET, not by where it sits: both invitation systems mint
 * `randomBytes(32).toString('hex')`, so any run of 32+ hex characters is
 * redacted from the path, the query and the referrer, after decoding. A match on
 * `/invite/` or on parameter names was bypassed by `//invite/`, `/%69nvite/`,
 * double encoding, or a token inside another parameter's value. A field that
 * needed redacting is stored decoded.
 */

const SECRET_RUN = /[0-9a-f]{32,}/gi;
const REDACTED = '[token]';
const MAX_DECODES = 3;

/** Percent-decoded until stable (bounded), so encoding cannot hide a token. */
function decoded(value: string): string {
  let current = value;
  for (let i = 0; i < MAX_DECODES; i++) {
    let next: string;
    try { next = decodeURIComponent(current.replace(/\+/g, ' ')); } catch { break; }
    if (next === current) break;
    current = next;
  }
  return current;
}

/** The value with every token-shaped run redacted; unchanged (exact bytes) when it holds none. */
function redact(value: string): string {
  const plain = decoded(value);
  return new RegExp(SECRET_RUN.source, 'i').test(plain) ? plain.replace(SECRET_RUN, REDACTED) : value;
}

export function scrubInvitePath(path: string): string {
  return redact(path);
}

/** A query string (no leading `?`). */
export function scrubInviteQuery(query: string | null): string | null {
  return query ? redact(query) : query;
}

/** A full referrer URL, without its fragment (the tracker never sends one; a referrer may). */
export function scrubInviteReferrer(referrer: string | null): string | null {
  if (!referrer) return referrer;
  const hash = referrer.indexOf('#');
  return redact(hash === -1 ? referrer : referrer.slice(0, hash));
}
