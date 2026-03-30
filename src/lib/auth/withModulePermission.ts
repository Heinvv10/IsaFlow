/**
 * Module-level permission middleware (WS-4.1).
 *
 * Wraps a company-scoped handler and checks granular permissions
 * before allowing access. Owner and admin roles bypass the check.
 *
 * Usage:
 *   export default withCompany(withErrorHandler(
 *     withModulePermission('customers', 'write')(handler as any) as any
 *   ));
 */

import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { checkPermission } from '@/modules/accounting/services/permissionService';
import { apiResponse } from '@/lib/apiResponse';
import type { CompanyApiRequest } from './withCompany';
import type { AuthenticatedNextApiRequest } from './middleware';

type Action = 'read' | 'write' | 'delete' | 'export' | 'approve';

/**
 * Returns a handler wrapper that enforces a module + action permission.
 * Must be used inside withCompany (companyId and companyRole must be set).
 */
export function withModulePermission(moduleKey: string, action: Action) {
  return (handler: NextApiHandler): NextApiHandler => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      const companyReq = req as CompanyApiRequest;
      const authReq = req as AuthenticatedNextApiRequest;

      const companyId = companyReq.companyId;
      const companyRole = companyReq.companyRole;
      const userId = authReq.user?.id;

      if (!companyId || !companyRole || !userId) {
        return apiResponse.forbidden(res, 'Company context or user identity missing.');
      }

      const allowed = await checkPermission(
        companyId,
        userId,
        companyRole,
        moduleKey,
        action
      );

      if (!allowed) {
        return apiResponse.forbidden(
          res,
          `Insufficient permissions: ${moduleKey}:${action}`
        );
      }

      return handler(req, res);
    };
  };
}
