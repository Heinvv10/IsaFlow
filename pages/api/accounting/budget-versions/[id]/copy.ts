/**
 * Copy a budget version (migration 947)
 * POST { name, kind } → 201 a draft in the same year, based on this one, with every amount copied
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { copyVersion } from '@/modules/accounting/services/budgets/budgetVersions';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { id } = req.query;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a version id');
  const { name, kind } = req.body ?? {};
  try {
    return apiResponse.created(res, await copyVersion(companyId, id, { name, kind }, { userId, role: companyRole }));
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
