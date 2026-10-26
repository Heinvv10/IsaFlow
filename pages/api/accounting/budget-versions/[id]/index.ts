/**
 * One budget version (migration 947)
 * GET    — the version, with its amount count and total
 * DELETE — not primary, not locked; a draft by any writer, an approved one by an owner or admin
 * Another company's id is a 404.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { deleteVersion, getVersion } from '@/modules/accounting/services/budgets/budgetVersions';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { id } = req.query;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a version id');
  try {
    if (req.method === 'GET') return apiResponse.success(res, await getVersion(companyId, id));
    if (req.method === 'DELETE') {
      await deleteVersion(companyId, id, { userId, role: companyRole });
      return apiResponse.success(res, { deleted: true });
    }
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
