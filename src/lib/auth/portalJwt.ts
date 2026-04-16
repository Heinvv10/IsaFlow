// src/lib/auth/portalJwt.ts
import { SignJWT, jwtVerify } from 'jose';
import { log } from '@/lib/logger';
import type { PortalSession } from '@/modules/accounting/services/afs/afsTypes';

const PORTAL_TOKEN_EXPIRY = '8h';

function getPortalSecret(): Uint8Array {
  const secret = process.env.PORTAL_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('PORTAL_JWT_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Sign a portal session token.
 * Uses PORTAL_JWT_SECRET — completely separate from staff JWT_SECRET.
 */
export async function signPortalToken(
  payload: PortalSession,
  expiresIn: string = PORTAL_TOKEN_EXPIRY,
): Promise<string> {
  const secret = getPortalSecret();
  const token = await new SignJWT({
    contactId: payload.contactId,
    companyId: payload.companyId,
    role: payload.role,
    expiresAt: payload.expiresAt,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.contactId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
  return token;
}

/**
 * Verify and decode a portal session token.
 * Returns PortalSession or null if invalid/expired.
 */
export async function verifyPortalToken(token: string): Promise<PortalSession | null> {
  try {
    const secret = getPortalSecret();
    const { payload } = await jwtVerify(token, secret);

    if (!payload.contactId || !payload.companyId || !payload.role) {
      return null;
    }

    return {
      contactId: payload.contactId as string,
      companyId: payload.companyId as string,
      role: payload.role as PortalSession['role'],
      expiresAt: payload.expiresAt as string,
    };
  } catch (err) {
    log.warn(
      'Portal token verification failed',
      { error: err instanceof Error ? err.message : String(err) },
      'portalJwt',
    );
    return null;
  }
}
