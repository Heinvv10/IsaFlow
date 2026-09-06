// src/lib/auth/withRole.ts
//
// Role gate — must be composed INSIDE withAuth, which is what sets
// req.companyRole. Split out of withAuth.ts to keep that file under the
// 300-line ceiling; withAuth.ts re-exports it, so existing import sites are
// unchanged.
import type { NextApiRequest, NextApiResponse } from 'next';
import { ROLE_HIERARCHY, type AuthRole } from './types';
import type { CompanyAuthedRequest } from './withAuth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

/**
 * Checks req.companyRole against the ROLE_HIERARCHY.
 *
 * Usage: withAuth(withRole('admin')(withErrorHandler(handler)))
 */
export function withRole(requiredRole: AuthRole) {
  return (handler: Handler): Handler => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      const authedReq = req as CompanyAuthedRequest;
      const userRoleLevel = ROLE_HIERARCHY[authedReq.companyRole as AuthRole] ?? 0;
      const requiredRoleLevel = ROLE_HIERARCHY[requiredRole] ?? 0;
      if (userRoleLevel < requiredRoleLevel) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: `This action requires ${requiredRole} role or higher` },
        });
      }
      return handler(req, res);
    };
  };
}
