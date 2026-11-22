/**
 * My Permissions API
 * GET /api/accounting/my-permissions
 * The signed-in user's own effective read/write/approve per module in the active company, by the rule the routes
 * enforce (`memberMay`: stored role, the user's company_user_permissions row, else the role default). Any member may ask: it
 * answers only for the session's user and company, never a query-string id. The nav uses it to hide
 * modules the user cannot read; hiding is cosmetic, the APIs (withPayrollModule for Payroll) decide access.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getMyModulePermissions } from '@/lib/auth/myPermissions';
import type { UserAuthedRequest } from '@/lib/auth/withUserAuth';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as UserAuthedRequest).user?.id;
  if (!companyId || !userId) {
    return apiResponse.forbidden(res, 'Company context or user identity missing.');
  }

  const modules = await getMyModulePermissions(companyId, userId);
  return apiResponse.success(res, { modules });
}

export default withAuth(withErrorHandler(handler));
