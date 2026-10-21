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

      if (!(await isPortalSessionInStanding(session))) {
        log.warn('Portal auth: company not live or contact inactive', {
          url: req.url, companyId: session.companyId, contactId: session.contactId,
        }, 'portalAuth');
        return res.status(401).json({
          success: false,
          error: { code: 'PORTAL_AUTH_INVALID', message: 'Portal session invalid or expired' },
        });
      }

      (req as PortalApiRequest).portalSession = session;
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

// The same live-company test sign-in applies, re-read on every request, and
// the contact still active on that company.
async function isPortalSessionInStanding(session: PortalSession): Promise<boolean> {
  if ((await listLiveCompanies([session.companyId])).length === 0) return false;
  const rows = (await sql`
    SELECT 1 AS ok FROM portal_contacts
    WHERE id = ${session.contactId}::UUID AND company_id = ${session.companyId}::UUID AND active = true
  `) as Record<string, unknown>[];
  return rows.length > 0;
}
