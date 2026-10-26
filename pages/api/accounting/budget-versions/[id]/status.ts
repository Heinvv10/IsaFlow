/**
 * Move a budget version's status (migration 947)
 * POST { action: 'approve' | 'lock' | 'unlock', reason?, expectedUpdatedAt? } → the version
 * Approve and lock: owner or admin; unlock: owner, with a reason. 409 when the version is no longer
 * in the status the move starts from (STATE) or changed since `expectedUpdatedAt` (STALE).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { isUuidParam } from '@/lib/validation';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { isVersionAction, transitionVersion } from '@/modules/accounting/services/budgets/budgetVersionStatus';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { id } = req.query;
  if (!isUuidParam(id)) return apiResponse.badRequest(res, 'id must be a version id');
  const { action, reason, expectedUpdatedAt } = req.body ?? {};
  if (!isVersionAction(action)) return apiResponse.badRequest(res, "action must be 'approve', 'lock' or 'unlock'");
  if (expectedUpdatedAt !== undefined && (typeof expectedUpdatedAt !== 'string' || !TIMESTAMP.test(expectedUpdatedAt))) {
    return apiResponse.badRequest(res, 'expectedUpdatedAt must be the updatedAt the version was read with');
  }
  try {
    const version = await transitionVersion(companyId, id, { action, reason, expectedUpdatedAt }, { userId, role: companyRole });
    return apiResponse.success(res, version);
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
