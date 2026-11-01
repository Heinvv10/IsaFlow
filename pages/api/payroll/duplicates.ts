/**
 * GET /api/payroll/duplicates
 * Returns employees flagged as sharing ID number, tax number, passport,
 * bank account, or employee number. Excludes terminated employees unless
 * ?includeTerminated=1. Bank account numbers are masked to their last four
 * except for owner / admin in their own session: Login-as and tokens get them
 * masked, whatever the role.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { isHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import { findDuplicates } from '@/modules/accounting/services/payroll/payrollDuplicateDetectionService';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const includeTerminated =
    req.query.includeTerminated === '1' || req.query.includeTerminated === 'true';

  const fullBankAccounts = isHistoryAdmin(companyRole) && (await isHumanSession());
  const result = await findDuplicates(companyId, { includeTerminated, fullBankAccounts });
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(withPayrollDetailAccess(handler)));
