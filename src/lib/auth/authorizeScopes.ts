/**
 * Which scopes /oauth/authorize puts on the consent screen, from the request's
 * `scope` parameter (FB-2).
 *
 *  - No `scope`, or an empty one: offer DEFAULT_MCP_SCOPES (read only). RFC
 *    6749 s3.3 lets the AS apply a default when the client omits the scope.
 *    It was a hard "At least one scope must be requested" refusal, which a
 *    generic MCP client that relies on the default could not get past.
 *  - `openid`, `profile` and `email` are dropped silently. Generic clients add
 *    them out of OIDC habit; this AS issues no ID token, and RFC 6749 s3.3 lets
 *    it grant fewer scopes than asked. If nothing is left after dropping them,
 *    the default applies, as for an absent scope.
 *  - Any OTHER unknown scope still refuses the whole request (the caller shows
 *    `rejectionForUnknownScope`, a constant).
 *
 * Nothing here grants anything: the user still sees the list and must press
 * Authorise, consent.ts re-validates every scope and keeps its own "at least
 * one scope" backstop, and write:post is never in the default and stays
 * opt-in at consent.
 */
import { DEFAULT_MCP_SCOPES, OAUTH_SCOPES } from './oauthScopes';

const VALID_SCOPES: ReadonlySet<string> = new Set<string>(OAUTH_SCOPES);

/** OIDC scopes a generic client may add; dropped, never refused. */
export const IGNORED_OIDC_SCOPES: ReadonlySet<string> = new Set(['openid', 'profile', 'email']);

export type AuthorizeScopes =
  | { ok: true; scopes: string[]; defaulted: boolean }
  | { ok: false; unknownScope: string };

export function resolveAuthorizeScopes(scopeParam: string): AuthorizeScopes {
  const requested = scopeParam.split(/[\s,]+/).filter(Boolean);
  const scopes: string[] = [];
  for (const s of requested) {
    if (IGNORED_OIDC_SCOPES.has(s)) continue;
    if (!VALID_SCOPES.has(s)) return { ok: false, unknownScope: s };
    if (!scopes.includes(s)) scopes.push(s);
  }
  if (scopes.length === 0) return { ok: true, scopes: [...DEFAULT_MCP_SCOPES], defaulted: true };
  return { ok: true, scopes, defaulted: false };
}
