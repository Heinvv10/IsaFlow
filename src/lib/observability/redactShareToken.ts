/** Share path credentials and token-named query values must never reach logs.
 * Query names may be percent-encoded; redact their entire value regardless of shape. */
const TOKEN_IN_PATH = /(\/share\/+)[A-Za-z0-9_-]{43}/gi;
const QUERY_VALUE = /([?&])([^=&#]+)=([^&#]*)/g;

/** THE rule for "is this parameter name a token?", so the URL redactor above
 *  and the parsed-query redactor below cannot disagree. They did: this module
 *  matched any name CONTAINING `token` while `api-error-handler.ts` redacted a
 *  key named exactly `token`, so a request logged with `?share_token=<token>`
 *  had it stripped from the URL string and written out in full from
 *  `req.query` on the very same log line. */
export function isTokenParamName(name: string): boolean {
  return name.toLowerCase().includes('token');
}

/** Replace any share token in a URL with `[token]`, so the URL can be logged.
 *  Production request logging writes `req.url` verbatim; anything in this
 *  feature that hands a URL to a log must pass it through here first.
 *
 *  Lives under `src/lib` (rather than the accounting module it protects) so
 *  that `src/lib` logging/observability code does not import from
 *  `src/modules`. There is no barrel and no re-export: every caller imports
 *  `@/lib/observability/redactShareToken` directly. */
export function redactShareToken(url: string): string {
  if (!url) return url;
  return url.replace(TOKEN_IN_PATH, '$1[token]').replace(QUERY_VALUE, (match, separator: string, name: string) => {
    let decoded: string;
    try { decoded = decodeURIComponent(name.replace(/\+/g, ' ')); }
    catch { decoded = name; }
    return isTokenParamName(decoded) ? `${separator}${name}=[token]` : match;
  });
}

/** Redact every token-named parameter of an already-parsed query object.
 *
 *  Unlike the URL forms above this does NOT check the value's shape. A parsed
 *  query is where a handler's own `token` lives too — a password-reset token,
 *  an invite token — and none of those belong in a log either. Returns the
 *  same object when there is nothing to redact, so the common request pays
 *  nothing.
 */
export function redactTokenParams<T extends Record<string, unknown>>(query: T | undefined): T | undefined {
  if (!query) return query;
  const keys = Object.keys(query).filter(isTokenParamName);
  if (keys.length === 0) return query;
  const out = { ...query } as Record<string, unknown>;
  for (const k of keys) out[k] = '[token]';
  return out as T;
}
