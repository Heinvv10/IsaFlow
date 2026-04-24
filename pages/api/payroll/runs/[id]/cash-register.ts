/**
 * GET /api/payroll/runs/:id/cash-register
 * Returns the ZAR denomination breakdown for cash-paid employees in the run.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { cashPayRegisterForRun } from '@/modules/accounting/services/payroll/cashPayRegisterService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing run id');
  try {
    const reg = await cashPayRegisterForRun(companyId, id);
    return apiResponse.success(res, reg);
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return apiResponse.notFound(res, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
