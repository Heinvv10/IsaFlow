/**
 * Employee portal authentication (wave 6 SS), modelled on portalAuth.ts and portalSession.ts. Completely separate
 * from staff withAuth and from the AR/AFS portals: its own cookie and key (employeePortalJwt), no GoTrue membership,
 * no company role.
 *
 * The token alone is not the session (8 hours). Every request re-checks, on the service pool by the token's ids
 * (compared as TEXT, so a non-UUID claim matches nothing instead of a 500): an ACTIVE login with that id, company and
 * employee, at the token's session_version (a revoke or re-invite bumps it), whose employee row is still that
 * company's; then the platform switch, the company setting and a live company (portalClosedReason); then the leaver
 * window. Anything else is 401 EMPLOYEE_PORTAL_AUTH, exactly as a forged token. Every answer is no-store.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { serialize } from 'cookie';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { portalClosedReason } from '@/modules/accounting/services/payroll/employeePortalSettings';
import { portalAccessOpen } from '@/modules/accounting/services/payroll/employeePortalWindow';
import {
  EMPLOYEE_PORTAL_COOKIE, EMPLOYEE_PORTAL_TTL_SECS, signEmployeePortalToken, verifyEmployeePortalToken, type EmployeePortalClaims,
} from './employeePortalJwt';

export type EmployeePortalRequest = NextApiRequest & { employeePortal: EmployeePortalClaims };
type Handler = (req: EmployeePortalRequest, res: NextApiResponse) => unknown;

/** The session as it stands now, or null. */
export async function currentEmployeePortalSession(token: string | undefined): Promise<EmployeePortalClaims | null> {
  if (!token) return null;
  const claims = await verifyEmployeePortalToken(token);
  if (!claims) return null;
  const rows = (await sql`
    SELECT e.status, e.end_date
      FROM employee_portal_access a
      JOIN payroll_employees e ON e.id = a.employee_id AND e.company_id = a.company_id
     WHERE a.id::TEXT = ${claims.accessId} AND a.company_id::TEXT = ${claims.companyId}
       AND a.employee_id::TEXT = ${claims.employeeId} AND a.status = 'active' AND a.session_version = ${claims.sessionVersion}
  `) as Array<{ status: string; end_date: string | null }>;
  const emp = rows[0];
  if (!emp) return null;
  if (await portalClosedReason(claims.companyId)) return null;
  if (!portalAccessOpen({ status: emp.status, endDate: emp.end_date })) return null;
  return claims;
}

export function withEmployeePortalAuth(handler: Handler) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    const raw: unknown = req.cookies?.[EMPLOYEE_PORTAL_COOKIE];
    const session = await currentEmployeePortalSession(typeof raw === 'string' ? raw : undefined);
    if (!session) {
      log.warn('Employee portal: no valid session', { url: req.url }, 'employeePortalAuth');
      return res.status(401).json({ success: false, error: { code: 'EMPLOYEE_PORTAL_AUTH', message: 'Please sign in again.' } });
    }
    (req as EmployeePortalRequest).employeePortal = session;
    return handler(req as EmployeePortalRequest, res);
  };
}

export async function setEmployeePortalCookie(res: NextApiResponse, claims: EmployeePortalClaims): Promise<void> {
  res.setHeader('Set-Cookie', serialize(EMPLOYEE_PORTAL_COOKIE, await signEmployeePortalToken(claims), {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: EMPLOYEE_PORTAL_TTL_SECS,
  }));
}

export function clearEmployeePortalCookie(res: NextApiResponse): void {
  res.setHeader('Set-Cookie', serialize(EMPLOYEE_PORTAL_COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 0,
  }));
}
