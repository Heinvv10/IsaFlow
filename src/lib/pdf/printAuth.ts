// src/lib/pdf/printAuth.ts
//
// Short-lived print token used by the Playwright PDF renderer
// (src/lib/pdf/renderPagePdf.ts) to authenticate its own headless-browser
// request against a specific, already-known API path — never a general
// login session. HMAC-SHA256 over `company_id|user_id|path|exp`, no
// external JWT library: the payload is small, fixed-shape, and the
// signature is checked in constant time below.
//
// `withAuth` (src/lib/auth/withAuth.ts) accepts this token as a fallback
// when GoTrue verification fails, ONLY when PRINT_TOKEN_SECRET is set and
// the token's bound path matches the incoming request's pathname exactly.
// If PRINT_TOKEN_SECRET is unset, verifyPrintToken always returns null and
// the branch is fully disabled.

import { createHmac, timingSafeEqual } from 'crypto';
import { log } from '@/lib/logger';

export interface PrintTokenPayload {
  companyId: string;
  userId: string;
  path: string;
  exp: number; // unix seconds
}

// M7-style floor (see src/lib/validateEnv.ts MIN_SECRET_LEN): a shorter
// secret is offline-forgeable. Enforced here too, not just in validateEnv,
// because validateEnv only runs at boot in production — this also protects
// dev/test against an operator pasting a short secret.
const MIN_SECRET_LEN = 32;

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

function sign(companyId: string, userId: string, path: string, exp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${companyId}|${userId}|${path}|${exp}`).digest('hex');
}

/** Mint a print token bound to one exact API path, expiring in `ttlSeconds`. */
export function mintPrintToken(companyId: string, userId: string, path: string, ttlSeconds = 120): string {
  const raw = process.env.PRINT_TOKEN_SECRET;
  if (!raw) throw new Error('PRINT_TOKEN_SECRET is not set');
  const secret = getSecret();
  if (!secret) throw new Error(`PRINT_TOKEN_SECRET must be at least ${MIN_SECRET_LEN} characters`);

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = sign(companyId, userId, path, exp, secret);
  const payload = Buffer.from(JSON.stringify({ companyId, userId, path, exp })).toString('base64url');
  return `${payload}.${signature}`;
}

function parsePayload(raw: string): PrintTokenPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    typeof (parsed as Record<string, unknown>).companyId !== 'string' ||
    typeof (parsed as Record<string, unknown>).userId !== 'string' ||
    typeof (parsed as Record<string, unknown>).path !== 'string' ||
    typeof (parsed as Record<string, unknown>).exp !== 'number'
  ) {
    return null;
  }
  return parsed as PrintTokenPayload;
}

/**
 * Verify a print token's signature and expiry only — NOT its bound path.
 * Returns the payload when: PRINT_TOKEN_SECRET is set (and long enough),
 * the token is well-formed, the signature matches, and it has not expired.
 *
 * Split out from `verifyPrintToken` so a caller (withAuth) can tell "this
 * is a garbage/forged/expired token" (clear cookies, 401 as normal) apart
 * from "this is a genuine print token, just not valid for this request"
 * (401 WITHOUT clearing cookies — an unrelated background call presenting
 * a token minted for a different path must not wipe out a render in
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

  const expected = sign(payload.companyId, payload.userId, payload.path, payload.exp, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signatureHex, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    log.warn('printAuth: signature mismatch', { path: payload.path }, 'printAuth');
    return null;
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    log.warn('printAuth: token expired', { companyId: payload.companyId, path: payload.path }, 'printAuth');
    return null;
  }

  return payload;
}

/**
 * Verify a print token against the path of the request presenting it.
 * Returns the payload only when: PRINT_TOKEN_SECRET is set, the token is
 * well-formed, the signature matches, it has not expired, and its bound
 * path is exactly `requestPath` (query string excluded by the caller).
 */
export function verifyPrintToken(token: string, requestPath: string): PrintTokenPayload | null {
  const payload = verifyPrintTokenSignature(token);
  if (!payload) return null;

  if (payload.path !== requestPath) {
    log.warn('printAuth: path mismatch', { tokenPath: payload.path, requestPath }, 'printAuth');
    return null;
  }

  return payload;
}
