/**
 * Budget versions (migration 947)
 * GET  — the company's versions, optionally of one year (`?fiscalYear=2027`) → { items }
 * POST — a new draft version { fiscalYear, name, kind } → 201 the version
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { parseYearLabel } from '@/modules/accounting/services/core/budgetMonths';
import { createVersion, listVersions } from '@/modules/accounting/services/budgets/budgetVersions';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    if (req.method === 'GET') {
      const raw = req.query.fiscalYear;
      const fiscalYear = raw === undefined ? undefined : parseYearLabel(raw);
      if (fiscalYear === null) return apiResponse.badRequest(res, 'fiscalYear must be a year label such as 2027');
      return apiResponse.success(res, { items: await listVersions(companyId, fiscalYear) });
    }
    if (req.method === 'POST') {
      const { fiscalYear, name, kind } = req.body ?? {};
      const label = parseYearLabel(fiscalYear);
      if (label === null) return apiResponse.badRequest(res, 'fiscalYear must be a year label such as 2027');
      const version = await createVersion(companyId, { fiscalYear: label, name, kind }, { userId, role: companyRole });
      return apiResponse.created(res, version);
    }
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
