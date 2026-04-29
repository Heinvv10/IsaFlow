// src/lib/auth/extensionJwt.ts
//
// Signer/verifier for the bank-feed browser-extension pairing token.
//
// Bound to a single bank_feed_connections row via `connectionId`. The
// extension stores this token in chrome.storage.local and sends it as
// `Authorization: Bearer <token>` on every ingest call. The JWT carries
// the company/user/connection identity needed to scope inserts; the
// connection's `is_active` flag in the DB is the revocation switch.

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

function getSecret(): Uint8Array {
  const secret = process.env.EXTENSION_SIGNING_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('EXTENSION_SIGNING_KEY must be set and at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

export async function signExtensionToken(payload: ExtensionTokenPayload): Promise<string> {
  const secret = getSecret();
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

export async function verifyExtensionToken(token: string): Promise<ExtensionTokenPayload | null> {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.cid !== 'string' ||
      typeof payload.conn !== 'string' ||
      typeof payload.bank !== 'string' ||
      payload.scope !== 'bank-feed-ingest'
    ) {
      return null;
    }
    return {
      userId: payload.sub,
      companyId: payload.cid,
      connectionId: payload.conn,
      bankId: payload.bank,
      scope: 'bank-feed-ingest',
    };
  } catch (err) {
    log.warn(
      'Extension token verification failed',
      { error: err instanceof Error ? err.message : String(err) },
      'extensionJwt',
    );
    return null;
  }
}
