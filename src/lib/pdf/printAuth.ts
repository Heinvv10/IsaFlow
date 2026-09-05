// src/lib/pdf/printAuth.ts
//
// Short-lived print token used by the Playwright PDF renderer
// (src/lib/pdf/renderPagePdf.ts) to authenticate its own headless-browser
// requests against a specific, already-known SET of API paths — never a
// general login session. HMAC-SHA256 over `company_id|user_id|paths|exp`,
// no external JWT library: the payload is small, fixed-shape, and the
// signature is checked in constant time below.
//
// `withAuth` (src/lib/auth/withAuth.ts) accepts this token as a fallback
// when GoTrue verification fails, ONLY when PRINT_TOKEN_SECRET is set and
// the incoming request's pathname is one of the token's bound paths,
// matched exactly. If PRINT_TOKEN_SECRET is unset, verifyPrintToken always
// returns null and the branch is fully disabled.

import { createHmac, timingSafeEqual } from 'crypto';
import { log } from '@/lib/logger';

export interface PrintTokenPayload {
  companyId: string;
  userId: string;
  /** Exact API pathnames this token authorises. Matched with ===, never by prefix. */
  paths: string[];
  exp: number; // unix seconds
}

// M7-style floor (see src/lib/validateEnv.ts MIN_SECRET_LEN): a shorter
// secret is offline-forgeable. Enforced here too, not just in validateEnv,
// because validateEnv only runs at boot in production — this also protects
// dev/test against an operator pasting a short secret.
const MIN_SECRET_LEN = 32;

// A newline cannot appear in a URL pathname, so joining on it makes the
// signature unambiguous: ['/a', '/b'] and ['/a,/b'] hash differently. A comma
// would not — a comma is legal in a pathname, and two different sets sharing a
// signature is a forged token. Both the minter and the parser reject a path
// containing the separator, so the join is injective for every set that can
// reach `sign`.
const PATH_SEP = '\n';

// The signed string is `company|user|paths|exp`, so a path containing `|` would
// let the same HMAC be re-split into a different tuple — one signature, two
// payloads. Banned on both sides for the same reason as PATH_SEP. Node's URL
// parser does NOT percent-encode `|` in a pathname, so the normalisation check
// below does not cover this; the explicit ban is load-bearing.
const FIELD_SEP = '|';

/** Returns the configured secret only when it meets the minimum length; a
 *  too-short secret is treated the same as "unset" (both mint and verify
 *  fail closed), but is logged so a misconfiguration is visible. */
function getSecret(): string | undefined {
  const secret = process.env.PRINT_TOKEN_SECRET;
  if (!secret) return undefined;
  if (secret.length < MIN_SECRET_LEN) {
    log.warn('printAuth: PRINT_TOKEN_SECRET is shorter than the minimum length', {
      minLength: MIN_SECRET_LEN,
    }, 'printAuth');
    return undefined;
  }
  return secret;
}

function sign(companyId: string, userId: string, paths: string[], exp: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${companyId}|${userId}|${paths.join(PATH_SEP)}|${exp}`)
    .digest('hex');
}

/**
 * A mintable path is an absolute, already-normalised API pathname: no query,
 * no fragment, no wildcard, no whitespace, no field/path separator, no
 * percent-encoding, and identical to what the URL parser makes of it. The last
 * clause is what rejects `..` segments, an authority-form `//host`, and
 * invisible characters such as U+200B that `\s` does not match. Percent-encoding
 * is banned outright because the URL parser leaves `%2F` and `%2e%2e` untouched,
 * so normalisation alone would let an encoded separator through.
 *
 * Only server code mints today, so this is a floor rather than a hole — but the
 * floor is what keeps a future caller from binding a token to a path that means
 * something different to the router than it does to the string comparison.
 */
function assertPaths(paths: string[]): void {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('mintPrintToken: at least one path is required');
  }
  for (const p of paths) {
    if (
      typeof p !== 'string' ||
      !p.startsWith('/') ||
      /[?#*\s|%]/.test(p) ||
      p.includes('//') ||
      p !== normalisedPathname(p)
    ) {
      throw new Error(`mintPrintToken: ${String(p)} is not an absolute API path without a query string`);
    }
  }
}

/** The pathname the URL parser derives from `p`, or null if it will not parse. */
function normalisedPathname(p: string): string | null {
  try {
    return new URL(p, 'http://x').pathname;
  } catch {
    return null;
  }
}

/** Mint a print token bound to an exact set of API paths, expiring in `ttlSeconds`. */
export function mintPrintToken(companyId: string, userId: string, paths: string[], ttlSeconds = 120): string {
  assertPaths(paths);
  const raw = process.env.PRINT_TOKEN_SECRET;
  if (!raw) throw new Error('PRINT_TOKEN_SECRET is not set');
  const secret = getSecret();
  if (!secret) throw new Error(`PRINT_TOKEN_SECRET must be at least ${MIN_SECRET_LEN} characters`);

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = sign(companyId, userId, paths, exp, secret);
  const payload = Buffer.from(JSON.stringify({ companyId, userId, paths, exp })).toString('base64url');
  return `${payload}.${signature}`;
}

function parsePayload(raw: string): PrintTokenPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.companyId !== 'string' ||
    typeof candidate.userId !== 'string' ||
    !Array.isArray(candidate.paths) ||
    candidate.paths.length === 0 ||
    // The separator guards are what keep `sign` injective: without PATH_SEP a
    // payload claiming paths ['/a\n/b'] would hash identically to ['/a', '/b'],
    // and without FIELD_SEP the same signed string could be re-split into a
    // different company/user/paths/exp tuple. Either way one set's signature
    // would validate another's payload.
    !candidate.paths.every((p) => typeof p === 'string' && !p.includes(PATH_SEP) && !p.includes(FIELD_SEP)) ||
    typeof candidate.exp !== 'number'
  ) {
    return null;
  }
  return candidate as unknown as PrintTokenPayload;
}

/**
 * Verify a print token's signature and expiry only — NOT its bound paths.
 * Returns the payload when: PRINT_TOKEN_SECRET is set (and long enough),
 * the token is well-formed, the signature matches, and it has not expired.
 *
 * Split out from `verifyPrintToken` so a caller (withAuth) can tell "this
 * is a garbage/forged/expired token" (clear cookies, 401 as normal) apart
 * from "this is a genuine print token, just not valid for this request"
 * (401 WITHOUT clearing cookies — an unrelated background call presenting
 * a token minted for different paths must not wipe out a render in
 * progress).
 */
export function verifyPrintTokenSignature(token: string): PrintTokenPayload | null {
  const secret = getSecret();
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signatureHex] = parts;
  if (!payloadB64 || !signatureHex) return null;

  const payload = parsePayload(payloadB64);
  if (!payload) return null;

  const expected = sign(payload.companyId, payload.userId, payload.paths, payload.exp, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signatureHex, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    log.warn('printAuth: signature mismatch', { paths: payload.paths }, 'printAuth');
    return null;
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    log.warn('printAuth: token expired', { companyId: payload.companyId, paths: payload.paths }, 'printAuth');
    return null;
  }

  return payload;
}

/**
 * Verify a print token against the path of the request presenting it.
 * Returns the payload only when: PRINT_TOKEN_SECRET is set, the token is
 * well-formed, the signature matches, it has not expired, and `requestPath`
 * is exactly one of its bound paths (query string excluded by the caller).
 */
export function verifyPrintToken(token: string, requestPath: string): PrintTokenPayload | null {
  const payload = verifyPrintTokenSignature(token);
  if (!payload) return null;

  // Exact match per path. `startsWith` here would authorise every route under
  // the bound prefix; see the prefix test in printAuth.test.ts.
  if (!payload.paths.includes(requestPath)) {
    log.warn('printAuth: path not authorised', { tokenPaths: payload.paths, requestPath }, 'printAuth');
    return null;
  }

  return payload;
}
