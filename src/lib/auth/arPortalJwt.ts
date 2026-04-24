// src/lib/auth/arPortalJwt.ts
//
// Signer / verifier for the legacy AR customer portal session cookie.
// Uses PORTAL_JWT_SECRET — completely separate from staff JWT_SECRET.
// Replaces the derived-from-staff-secret pattern flagged in pentest H1.
//
// This is distinct from `portalJwt.ts` (AFS portal) which has a different
// claim shape (contactId/role/expiresAt). The AR portal authenticates against
// the `portal_access` table and tracks `clientId` (customer UUID).

import { SignJWT, jwtVerify } from 'jose';
import { log } from '@/lib/logger';

export interface ArPortalSession {
  clientId: string;
  companyId: string;
  email: string;
}

const AR_PORTAL_TOKEN_EXPIRY = '24h';

function getSecret(): Uint8Array {
  const secret = process.env.PORTAL_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('PORTAL_JWT_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

export async function signArPortalToken(payload: ArPortalSession): Promise<string> {
  const secret = getSecret();
  return await new SignJWT({
    clientId: payload.clientId,
    companyId: payload.companyId,
    email: payload.email,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.clientId)
    .setIssuedAt()
    .setExpirationTime(AR_PORTAL_TOKEN_EXPIRY)
    .sign(secret);
}

export async function verifyArPortalToken(token: string): Promise<ArPortalSession | null> {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (
      typeof payload.clientId !== 'string' ||
      typeof payload.companyId !== 'string' ||
      typeof payload.email !== 'string'
    ) {
      return null;
    }
    return {
      clientId: payload.clientId,
      companyId: payload.companyId,
      email: payload.email,
    };
  } catch (err) {
    log.warn(
      'AR portal token verification failed',
      { error: err instanceof Error ? err.message : String(err) },
      'arPortalJwt',
    );
    return null;
  }
}
