// src/lib/auth/withRole.ts
//
// Role gate — must be composed INSIDE withAuth, which is what sets
// req.companyRole. Split out of withAuth.ts to keep that file under the
// 300-line ceiling; withAuth.ts re-exports it, so existing import sites are
// unchanged.
import type { NextApiRequest, NextApiResponse } from 'next';
import type { AuthRole } from './types';
import type { CompanyAuthedRequest } from './withAuth';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

/**
 * The company roles each level admits: an explicit list, not a rank. Ranking
 * through ROLE_HIERARCHY let `system` and `super_admin` through withRole('admin')
 * — both rank above admin, and neither is a company role. A level is added here
 * before a route may name it; the parameter type makes an unlisted one a compile error.
 */
export const WITH_ROLE_ADMITS = {
  admin: ['owner', 'admin'],
} as const satisfies Record<string, readonly AuthRole[]>;

export type WithRoleLevel = keyof typeof WITH_ROLE_ADMITS;

/**
 * Admits req.companyRole only when it is in WITH_ROLE_ADMITS[requiredRole], on
 * every method (GET included).
 *
 * Usage: withAuth(withRole('admin')(withErrorHandler(handler)))
 */
export function withRole(requiredRole: WithRoleLevel) {
  if (!Object.hasOwn(WITH_ROLE_ADMITS, requiredRole)) {
    throw new Error(`withRole: no allow-list for level '${String(requiredRole)}'`);
  }
  const admits: readonly string[] = WITH_ROLE_ADMITS[requiredRole];
  return (handler: Handler): Handler => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      const { companyRole } = req as CompanyAuthedRequest;
      if (typeof companyRole !== 'string' || !admits.includes(companyRole)) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: `This action requires ${requiredRole} role or higher` },
        });
      }
      return handler(req, res);
    };
  };
}
