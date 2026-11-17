/**
 * The employee portal's session token (wave 6 SS). Its own cookie (`employee_portal_session`), its own audience and
 * its own key: the key is HMAC-SHA256(PORTAL_JWT_SECRET, a fixed label), so neither AR/AFS portal token (signed with
 * PORTAL_JWT_SECRET itself) nor a staff token (JWT_SECRET) verifies here, whatever claims it carries, and this token
 * verifies nowhere else. The claims name the login row, its company and employee, and the row's session_version at
 * sign-in; the request check (employeePortalAuth) compares all four with the row as it stands.
 */
import { createHmac } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { log } from '@/lib/logger';

export const EMPLOYEE_PORTAL_COOKIE = 'employee_portal_session';
export const EMPLOYEE_PORTAL_TTL_SECS = 8 * 60 * 60;
const AUDIENCE = 'isaflow-employee-portal';
const KEY_LABEL = 'isaflow employee portal session v1';

export interface EmployeePortalClaims { accessId: string; companyId: string; employeeId: string; sessionVersion: number }

function key(): Uint8Array {
  const secret = process.env.PORTAL_JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('PORTAL_JWT_SECRET must be set and at least 32 characters');
  return new Uint8Array(createHmac('sha256', secret).update(KEY_LABEL).digest());
}

export async function signEmployeePortalToken(c: EmployeePortalClaims): Promise<string> {
  return new SignJWT({ cid: c.companyId, eid: c.employeeId, sv: c.sessionVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.accessId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${EMPLOYEE_PORTAL_TTL_SECS}s`)
    .sign(key());
}

export async function verifyEmployeePortalToken(token: string): Promise<EmployeePortalClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'], audience: AUDIENCE });
    const { sub, cid, eid, sv } = payload;
    if (typeof sub !== 'string' || typeof cid !== 'string' || typeof eid !== 'string' || !Number.isInteger(sv)) return null;
    return { accessId: sub, companyId: cid, employeeId: eid, sessionVersion: sv as number };
  } catch (err) {
    log.warn('Employee portal token refused', { error: err instanceof Error ? err.message : String(err) }, 'employeePortalJwt');
    return null;
  }
}
