// src/lib/auth/extensionJwt.ts
//
// Signer/verifier for the bank-feed browser-extension pairing token.
//
// Bound to a single bank_feed_connections row via `connectionId`. The
// extension stores this token in chrome.storage.local and sends it as
// `Authorization: Bearer <token>` on every ingest call. The JWT carries
// the company/user/connection identity needed to scope inserts; the
// connection's `is_active` flag in the DB is the revocation switch.
//
// Key rotation:
//   Active key  → EXTENSION_SIGNING_KEY  (required, ≥32 chars)
//   Legacy key  → EXTENSION_SIGNING_KEY_LEGACY (optional; valid during rotation window)
//
// Rotation procedure:
//   1. Set EXTENSION_SIGNING_KEY_LEGACY = current EXTENSION_SIGNING_KEY
//   2. Deploy new EXTENSION_SIGNING_KEY — new pairs use the new key
//   3. Wait 90 days (token expiry) for all legacy tokens to expire
//   4. Remove EXTENSION_SIGNING_KEY_LEGACY

import { SignJWT, jwtVerify } from 'jose';
import { log } from '@/lib/logger';

export interface ExtensionTokenPayload {
  userId: string;
  companyId: string;
  connectionId: string;
  bankId: string;
  scope: 'bank-feed-ingest';
}

const EXTENSION_TOKEN_EXPIRY = '90d';

function getSecret(envKey: string): Uint8Array {
  const secret = process.env[envKey];
  if (!secret || secret.length < 32) {
    throw new Error(`${envKey} must be set and at least 32 characters`);
  }
  return new TextEncoder().encode(secret);
}

export async function signExtensionToken(payload: ExtensionTokenPayload): Promise<string> {
  const secret = getSecret('EXTENSION_SIGNING_KEY');
  return await new SignJWT({
    cid: payload.companyId,
    conn: payload.connectionId,
    bank: payload.bankId,
    scope: payload.scope,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(EXTENSION_TOKEN_EXPIRY)
    .sign(secret);
}

function extractPayload(raw: unknown): ExtensionTokenPayload | null {
  if (
    typeof raw !== 'object' || raw === null ||
    typeof (raw as Record<string, unknown>).sub !== 'string' ||
    typeof (raw as Record<string, unknown>).cid !== 'string' ||
    typeof (raw as Record<string, unknown>).conn !== 'string' ||
    typeof (raw as Record<string, unknown>).bank !== 'string' ||
    (raw as Record<string, unknown>).scope !== 'bank-feed-ingest'
  ) {
    return null;
  }
  const p = raw as Record<string, unknown>;
  return {
    userId: p.sub as string,
    companyId: p.cid as string,
    connectionId: p.conn as string,
    bankId: p.bank as string,
    scope: 'bank-feed-ingest',
  };
}

export async function verifyExtensionToken(token: string): Promise<ExtensionTokenPayload | null> {
  // Try active key first, then legacy key during rotation window.
  const keysToTry: string[] = ['EXTENSION_SIGNING_KEY'];
  if (process.env.EXTENSION_SIGNING_KEY_LEGACY) {
    keysToTry.push('EXTENSION_SIGNING_KEY_LEGACY');
  }

  for (const envKey of keysToTry) {
    try {
      const secret = getSecret(envKey);
      const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      const result = extractPayload(payload);
      if (result) return result;
    } catch (err) {
      log.debug('JWT key attempt failed', { envKey, error: err instanceof Error ? err.message : String(err) }, 'extensionJwt');
    }
  }

  log.warn('Extension token verification failed against all keys', {}, 'extensionJwt');
  return null;
}
