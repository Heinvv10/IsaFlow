/**
 * GET /api/payroll/duplicates
 * Returns employees flagged as sharing ID number, tax number, passport,
 * bank account, or employee number. Excludes terminated employees unless
 * ?includeTerminated=1.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { findDuplicates } from '@/modules/accounting/services/payroll/payrollDuplicateDetectionService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const includeTerminated =
    req.query.includeTerminated === '1' || req.query.includeTerminated === 'true';

  const result = await findDuplicates(companyId, { includeTerminated });
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(handler));
