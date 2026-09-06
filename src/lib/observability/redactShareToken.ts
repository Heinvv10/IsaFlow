/** A 43-character base64url run is a share token wherever it sits after a
 *  `/share/` path segment or in a query parameter whose NAME contains `token`.
 *  Both forms are redacted; a 43-character segment anywhere else is left alone,
 *  because uuids and ids of other shapes must stay readable in logs.
 *
 *  Case-insensitive, and tolerant of repeated slashes, because a proxy or a
 *  hand-typed link can present `/SHARE//<token>` and Next.js will still route
 *  it — a redactor that only matched the canonical form would pass the token
 *  straight through to the log. The parameter name is matched loosely
 *  (`token`, `share_token`, `t_token`) for the same reason. */
const TOKEN_IN_PATH = /(\/share\/+)[A-Za-z0-9_-]{43}/gi;
const TOKEN_IN_QUERY = /([?&][^=&#]*token[^=&#]*=)[A-Za-z0-9_-]{43}/gi;

/** Replace any share token in a URL with `[token]`, so the URL can be logged.
 *  Production request logging writes `req.url` verbatim; anything in this
 *  feature that hands a URL to a log must pass it through here first.
 *
 *  Lives under `src/lib` (rather than the accounting module it protects) so
 *  that `src/lib` logging/observability code does not import from
 *  `src/modules`; the service re-exports this for its own callers. */
export function redactShareToken(url: string): string {
  if (!url) return url;
  return url.replace(TOKEN_IN_PATH, '$1[token]').replace(TOKEN_IN_QUERY, '$1[token]');
}
