/**
 * POST /api/oauth/register — RFC 7591 dynamic client registration.
 *
 * Unauthenticated by design (open registration — Claude Code / Desktop /
 * claude.ai / Codex self-register before the user ever logs in). Creates
 * PUBLIC clients only: no client_secret, token_endpoint_auth_method 'none',
 * PKCE mandatory at consent (pages/api/oauth/consent.ts) and token exchange.
 * A client that ASKS for a confidential auth method is downgraded to public
 * rather than rejected (RFC 7591 §3.2.1) — see the note at that check.
 *
 * Abuse controls: 10 registrations/hour/IP ('oauth-register' bucket),
 * ≤5 redirect URIs, https-only redirect URIs except RFC 8252 loopback
 * (http://localhost:*, http://127.0.0.1:*) and the exact native-app URIs in
 * src/lib/auth/oauthNativeRedirects.ts (Cursor / Grok Bot).
 *
 * Responses use the raw RFC 7591 shape, not the apiResponse envelope
 * (clients parse this verbatim — same precedent as /api/oauth/token).
 */
import type { NextApiHandler } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { isReservedClientName } from '@/lib/auth/reservedClientName';
import { isLoopbackHost } from '@/lib/auth/oauthLoopback';
import { isAllowedNativeRedirect } from '@/lib/auth/oauthNativeRedirects';
import { log } from '@/lib/logger';
import { registerOauthApp } from '@/lib/auth/oauth';
import { pruneStaleDynamicApps } from '@/lib/auth/oauthDynamicClients';

// Anonymous endpoint — cap the body like /api/oauth/token does.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8kb',
    },
  },
};

const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LEN = 512;
const MAX_NAME_LEN = 80;

const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const SUPPORTED_RESPONSE_TYPES = ['code'];

function rfcError(code: string, description: string): { error: string; error_description: string } {
  return { error: code, error_description: description };
}

/**
 * https everywhere; plain http only for RFC 8252 loopback redirects; and the
 * exact native-app URIs in oauthNativeRedirects.ts (RFC 8252 s7.1), so Cursor
 * and Grok Bot can register. No other non-https scheme.
 */
function isAcceptableRedirect(raw: string): boolean {
  if (isAllowedNativeRedirect(raw)) return true;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return true;
  return false;
}

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  // Kill switch — dark by default, armed per environment (SARS-ISV pattern;
  // the mcp_connector flag is per-company and this endpoint has no tenant).
  if (process.env.MCP_DCR_ENABLED !== 'true') {
    return res.status(503).json(
      rfcError('temporarily_unavailable', 'Dynamic client registration is not enabled'),
    );
  }

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(`oauth-register:${ip}`, { max: 10, windowSecs: 3600 });
  if (!allowed) {
    log.warn('DCR: registration rate limit exceeded', { ip }, 'oauth');
    return res.status(429).json(rfcError('invalid_client_metadata', 'Too many registrations. Try again later.'));
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return res.status(400).json(rfcError('invalid_redirect_uri', 'redirect_uris is required and must be non-empty'));
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return res.status(400).json(rfcError('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect URIs allowed`));
  }
  for (const u of redirectUris) {
    if (typeof u === 'string' && u.length > MAX_REDIRECT_URI_LEN) {
      return res.status(400).json(
        rfcError('invalid_redirect_uri', `Each redirect URI must be ≤ ${MAX_REDIRECT_URI_LEN} characters`),
      );
    }
    if (typeof u !== 'string' || !isAcceptableRedirect(u)) {
      return res.status(400).json(
        rfcError('invalid_redirect_uri', 'redirect_uris must be https URLs (http allowed for localhost/127.0.0.1 loopback only; custom schemes only from a fixed native-app list)'),
      );
    }
  }

  // Optional metadata — validate what we honour, reject what we can't.
  // NFC first, so the name we STORE and later display is the same string the
  // reserved-name check compares. Some code points are letters the browser
  // declines to draw — the CJK compatibility ideographs (U+FACF, U+2F803 and
  // kin) render as nothing in Chromium even with CJK fonts installed, while
  // occupying a full ideograph cell. "Isa<U+FACF>Flow" therefore READS as
  // "Isa Flow", which this endpoint refuses, while comparing as neither. They
  // are canonical singletons, so NFC maps each to the ideograph it stands for
  // — a glyph that does render — and the gap between shown and compared closes
  // at the boundary rather than in the matcher, which was right all along.
  //
  // A name already in NFC is stored byte-identical; a DECOMPOSED one is not,
  // and that is the point — a macOS pasteboard hands you NFD, and composing it
  // means the stored name is compared as the same thing it displays as.
  //
  // Normalise BEFORE the slice, not after. `.slice()` counts UTF-16 units and
  // NFC can EXPAND: U+FACF is one unit, its canonical target is a surrogate
  // pair, so cutting first would store 81 units against this 80-unit cap.
  //
  // Truncate BEFORE the reserved-name check, never after: the check's cost
  // grows with length, and it runs before the global rate limit is charged, so
  // a refused name is bounded only by this cut (~0.6ms at 80 chars, ~20ms on
  // an untruncated 8kb body).
  const clientName =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().normalize('NFC').slice(0, MAX_NAME_LEN)
      : 'MCP Client';
  if (isReservedClientName(clientName)) {
    return res.status(400).json(
      rfcError('invalid_client_metadata', 'client_name may not impersonate IsaFlow or use a reserved term'),
    );
  }
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : SUPPORTED_GRANT_TYPES;
  if (grantTypes.some((g) => !SUPPORTED_GRANT_TYPES.includes(String(g)))) {
    return res.status(400).json(rfcError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported'));
  }
  const responseTypes = Array.isArray(body.response_types) ? body.response_types : SUPPORTED_RESPONSE_TYPES;
  if (responseTypes.some((r) => !SUPPORTED_RESPONSE_TYPES.includes(String(r)))) {
    return res.status(400).json(rfcError('invalid_client_metadata', 'Only the code response type is supported'));
  }
  // token_endpoint_auth_method is deliberately NOT validated. RFC 7591 §3.2.1
  // lets the AS replace requested metadata with what it will actually honour,
  // and §3.1 requires the client to use the values returned in the response.
  // claude.ai's web connector requests 'client_secret_post'; rejecting that
  // stopped it registering at all ("Couldn't register with IsaFlow's sign-in
  // service"). We always issue a PUBLIC client and echo 'none' below, so the
  // client downgrades to PKCE — no secret is ever minted from this
  // unauthenticated endpoint, which is the property the old 400 protected.

  // Global cap — bounds total registrations/hour across ALL IPs so IP rotation
  // can't grow oauth_apps unbounded within the 30-day prune window. Charged
  // only here (after validation), so cheap rejected requests can't burn the
  // budget and deny legitimate registrations.
  if (!(await checkRateLimit('oauth-register-global', { max: 100, windowSecs: 3600 }))) {
    log.warn('DCR: global registration cap reached', { ip }, 'oauth');
    return res.status(429).json(rfcError('invalid_client_metadata', 'Registration is temporarily throttled. Try again later.'));
  }

  const app = await registerOauthApp({
    ownerUserId: null,
    name: clientName,
    redirectUris: redirectUris as string[],
    dynamic: true,
  });

  log.info('DCR: public client registered', { appId: app.id, clientName, ip }, 'oauth');

  // Opportunistic cleanup of stale never-authorised dynamic rows — keeps the
  // table bounded without a cron. Fire-and-forget; never blocks the response.
  void pruneStaleDynamicApps().catch((err: unknown) =>
    log.warn('DCR: prune failed', { err: err instanceof Error ? err.message : String(err) }, 'oauth'),
  );

  return res.status(201).json({
    client_id: app.clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: SUPPORTED_GRANT_TYPES,
    response_types: SUPPORTED_RESPONSE_TYPES,
  });
};

export default withErrorHandler(handler);
