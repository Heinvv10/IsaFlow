/**
 * Native-app redirect URIs that dynamic client registration accepts, in one
 * place.
 *
 * Registration otherwise takes https URLs and RFC 8252 loopback only. Cursor
 * (and Grok Bot, which uses Cursor's connector stack) registers with three
 * redirect URIs, one of them the private-use scheme below; one refused entry
 * fails the whole registration, so neither client could connect at all
 * (Cursor forum thread 171877: the same list on desktop and Cloud Agents, and
 * "connectors authenticate only via OAuth").
 *
 * RFC 8252 s7.1 allows private-use URI schemes for native apps. We accept them
 * as an EXACT-STRING allowlist, never as a scheme rule: no prefix match, no
 * other custom scheme, no wildcard, and no query or fragment (an exact match
 * rejects those anyway; the check below says so explicitly). A local program
 * could claim `cursor://`, the same class of risk as a loopback port, which is
 * already accepted: PKCE, the exact match at authorize/consent/token and the
 * consent screen naming the target (`consentRedirectTarget.ts`) bound it.
 *
 * Two callers must agree, as with `oauthLoopback.ts`: registration decides
 * whether to ACCEPT the URI, and the consent screen decides how to DESCRIBE it.
 */
export interface NativeRedirect {
  /** What the consent screen calls the receiving app. */
  appLabel: string;
  /** The scheme and authority shown next to the label. */
  target: string;
}

const NATIVE_REDIRECTS: ReadonlyMap<string, NativeRedirect> = new Map([
  [
    'cursor://anysphere.cursor-mcp/oauth/callback',
    { appLabel: 'the Cursor app on this computer', target: 'cursor://anysphere.cursor-mcp' },
  ],
]);

export const ALLOWED_NATIVE_REDIRECT_URIS: ReadonlySet<string> = new Set(NATIVE_REDIRECTS.keys());

export function isAllowedNativeRedirect(raw: string): boolean {
  if (raw.includes('?') || raw.includes('#')) return false;
  return ALLOWED_NATIVE_REDIRECT_URIS.has(raw);
}

/** The consent-screen description of an allowlisted native URI, else null. */
export function describeNativeRedirect(raw: string): NativeRedirect | null {
  return isAllowedNativeRedirect(raw) ? (NATIVE_REDIRECTS.get(raw) ?? null) : null;
}
