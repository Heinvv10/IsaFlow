/**
 * RFC 8707 resource indicators and the RFC 9207 `iss` parameter (FB-4).
 *
 * ISAFlow has ONE protected resource, `${origin}/api/mcp`, and its tokens are
 * opaque and only ever validated there, so audience binding already holds. What
 * was missing is the protocol answer: a client that names a DIFFERENT resource
 * must be told `invalid_target` (RFC 8707 s2) rather than handed a token for
 * this one. Nothing is stored: with a single resource there is nothing to bind.
 *
 * Accepted `resource` values (when present; absent is always fine):
 *  - `${origin}/api/mcp`, scheme and host compared case-insensitively, one
 *    trailing slash ignored;
 *  - the bare origin (`${origin}` or `${origin}/`): some clients send the
 *    server URL without the path. Accepted, with a warning log, so a client
 *    that worked before this change keeps working.
 * Anything else, a query or fragment included (RFC 8707 s2: MUST NOT include a
 * fragment), is `invalid_target`.
 *
 * `oauthIssuer()` is the exact `issuer` the RFC 8414 metadata document serves:
 * RFC 9207 requires the `iss` on the authorization response to be identical.
 */
const MCP_RESOURCE_PATH = '/api/mcp';

export function oauthIssuer(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za';
}

export type ResourceCheck = { ok: true; bareOrigin: boolean } | { ok: false };

/** `raw` is the request's `resource` value(s); undefined/empty means "not sent". */
export function checkResourceIndicator(raw: unknown): ResourceCheck {
  if (raw === undefined || raw === null || raw === '') return { ok: true, bareOrigin: false };
  const values = Array.isArray(raw) ? raw : [raw];
  let bareOrigin = false;
  for (const v of values) {
    const one = checkOne(v);
    if (!one.ok) return one;
    bareOrigin ||= one.bareOrigin;
  }
  return { ok: true, bareOrigin };
}

function checkOne(value: unknown): ResourceCheck {
  if (typeof value !== 'string' || value.includes('#') || value.includes('?')) return { ok: false };
  let got: URL;
  let want: URL;
  try {
    got = new URL(value);
    want = new URL(oauthIssuer());
  } catch {
    return { ok: false };
  }
  // URL lower-cases scheme and host already; compare them, then the path.
  if (got.protocol !== want.protocol || got.host !== want.host) return { ok: false };
  if (got.username || got.password) return { ok: false };
  const path = got.pathname.endsWith('/') ? got.pathname.slice(0, -1) : got.pathname;
  if (path === MCP_RESOURCE_PATH) return { ok: true, bareOrigin: false };
  if (path === '') return { ok: true, bareOrigin: true };
  return { ok: false };
}

/**
 * The redirect an authorization ERROR goes back to the client with (RFC 6749
 * s4.1.2.1), carrying `iss` (RFC 9207). Only call it with a redirect_uri that
 * has already been matched against the client's registration.
 */
export function authorizationErrorRedirect(
  redirectUri: string,
  error: string,
  state: string,
  issuer: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.toString();
}
