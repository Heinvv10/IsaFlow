/**
 * Portal authentication middleware.
 * Reads the `portal_session` cookie, verifies via verifyPortalToken,
 * attaches `portalSession` to req, or returns 401.
 * Completely separate from staff withAuth — uses PORTAL_JWT_SECRET.
 */

import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { verifyPortalToken } from '@/lib/auth/portalJwt';
import { listLiveCompanies } from '@/lib/auth/liveCompanies';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PortalSession } from '@/modules/accounting/services/afs/afsTypes';

export type PortalApiRequest = NextApiRequest & { portalSession: PortalSession };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PortalHandler = (req: any, res: NextApiResponse<any>) => any;

/**
 * Middleware that requires a valid portal session cookie.
 *
 * Cookie name: `portal_session`
 * Cookie value: signed JWT from signPortalToken
 *
 * On success: attaches `portalSession` to request, calls handler.
 * On failure: returns 401 with PORTAL_AUTH_REQUIRED, or PORTAL_AUTH_INVALID
 * for a bad token AND for a session whose company is no longer live or whose
 * contact was deactivated since sign-in (the JWT lasts 8 hours; audit S-08).
 * The attached session carries the contact's CURRENT role.
 */
export function withPortalAuth(handler: PortalHandler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    try {
      const rawCookie: unknown = req.cookies?.['portal_session'];
      if (!rawCookie || typeof rawCookie !== 'string') {
        log.warn('Portal auth: missing portal_session cookie', { url: req.url }, 'portalAuth');
        return res.status(401).json({
          success: false,
          error: { code: 'PORTAL_AUTH_REQUIRED', message: 'Portal session required' },
        });
      }

      const session = await verifyPortalToken(rawCookie);
      if (!session) {
        log.warn('Portal auth: invalid or expired portal_session token', { url: req.url }, 'portalAuth');
        return res.status(401).json({
          success: false,
          error: { code: 'PORTAL_AUTH_INVALID', message: 'Portal session invalid or expired' },
        });
      }

      const current = await currentPortalSession(session);
      if (!current) {
        log.warn('Portal auth: company not live or contact inactive', {
          url: req.url, companyId: session.companyId, contactId: session.contactId,
        }, 'portalAuth');
        return res.status(401).json({
          success: false,
          error: { code: 'PORTAL_AUTH_INVALID', message: 'Portal session invalid or expired' },
        });
      }

      (req as PortalApiRequest).portalSession = current;
      return handler(req, res);
    } catch (err) {
      log.error(
        'Portal auth middleware error',
        err instanceof Error ? { message: err.message } : { err },
        'portalAuth',
      );
      return res.status(500).json({
        success: false,
        error: { code: 'PORTAL_AUTH_ERROR', message: 'Portal authentication error' },
      });
    }
  };
}

/**
 * A verified portal session as it stands NOW: null when its company is no
 * longer live or its contact was deactivated since sign-in, otherwise the
 * session with the contact's current role (the JWT's is 8 hours old). Every
 * server-side reader of the portal cookie uses this after verifyPortalToken.
 */
export async function currentPortalSession(session: PortalSession): Promise<PortalSession | null> {
  if ((await listLiveCompanies([session.companyId])).length === 0) return null;
  const rows = (await sql`
    SELECT role FROM portal_contacts
    WHERE id = ${session.contactId}::UUID AND company_id = ${session.companyId}::UUID AND active = true
  `) as Array<{ role: PortalSession['role'] }>;
  const role = rows[0]?.role;
  return role ? { ...session, role } : null;
}
