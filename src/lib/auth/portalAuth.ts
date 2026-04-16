/**
 * Portal authentication middleware.
 * Reads the `portal_session` cookie, verifies via verifyPortalToken,
 * attaches `portalSession` to req, or returns 401.
 * Completely separate from staff withCompany — uses PORTAL_JWT_SECRET.
 */

import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { verifyPortalToken } from '@/lib/auth/portalJwt';
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
 * On failure: returns 401 with PORTAL_AUTH_REQUIRED.
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
