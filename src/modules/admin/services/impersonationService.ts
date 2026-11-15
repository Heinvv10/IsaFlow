/**
 * Impersonation Service
 * Short-lived JWT tokens allowing super_admin to view the app as a specific company.
 *
 * Pentest L1: signs with a dedicated IMPERSONATION_JWT_SECRET, not the shared
 * JWT_SECRET. 30 min TTL means a straight rotation is safe — any in-flight
 * token expires within the deploy window; worst case, an admin re-impersonates.
 */

import { SignJWT, jwtVerify } from 'jose';
import { log } from '@/lib/logger';
import { listLiveCompanies } from '@/lib/auth/liveCompanies';
import { isUuidParam } from '@/lib/validation';

const IMPERSONATION_EXPIRY_MINUTES = 30;

function getSecret(): Uint8Array {
  const secret = process.env.IMPERSONATION_JWT_SECRET;
  if (!secret) throw new Error('IMPERSONATION_JWT_SECRET environment variable is not set');
  return new TextEncoder().encode(secret);
}

export interface ImpersonationTokenPayload {
  admin_user_id: string;
  company_id: string;
}

/**
 * Whether `companyId` names a company that can be impersonated: one a session may be scoped to (listLiveCompanies,
 * the predicate impersonate-exchange and withAuth apply): it exists, is_active, and is neither deleted nor suspended
 * (status or suspended_at). Anything else the exchange refuses, so no token is minted or audited for it (admin audit
 * 2026-11-14 F-13; review #1407).
 */
export async function companyCanBeImpersonated(companyId: string): Promise<boolean> {
  if (!isUuidParam(companyId)) return false;
  return (await listLiveCompanies([companyId])).length > 0;
}

/**
 * Create a short-lived impersonation JWT. Callers check companyCanBeImpersonated first.
 * Returns the token string and an ISO expiry timestamp.
 */
export async function createImpersonationToken(
  adminUserId: string,
  companyId: string
): Promise<{ token: string; expires_at: string }> {
  const secret = getSecret();
  const expiresAt = new Date(
    Date.now() + IMPERSONATION_EXPIRY_MINUTES * 60 * 1000
  );

  try {
    const token = await new SignJWT({
      impersonating: true,
      company_id: companyId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(adminUserId)
      .setIssuedAt()
      .setExpirationTime(`${IMPERSONATION_EXPIRY_MINUTES}m`)
      .sign(secret);

    return { token, expires_at: expiresAt.toISOString() };
  } catch (err) {
    log.error(
      'createImpersonationToken failed',
      { adminUserId, companyId, error: err },
      'impersonationService'
    );
    throw err;
  }
}

/**
 * Verify an impersonation JWT.
 * Returns the decoded payload or null if invalid / expired.
 */
export async function validateImpersonationToken(
  token: string
): Promise<ImpersonationTokenPayload | null> {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret);

    if (
      !payload.sub ||
      payload.impersonating !== true ||
      typeof payload.company_id !== 'string'
    ) {
      return null;
    }

    return {
      admin_user_id: payload.sub,
      company_id: payload.company_id,
    };
  } catch (err) {
    // Expired or tampered tokens are expected — only log unexpected errors
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('expired') && !msg.includes('JWTExpired')) {
      log.error('validateImpersonationToken error', { error: err }, 'impersonationService');
    }
    return null;
  }
}
