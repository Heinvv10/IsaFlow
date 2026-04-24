/**
 * Chart of Accounts — Next Code Suggestion
 * GET /api/accounting/chart-of-accounts-next-code?accountType=asset&accountSubtype=bank&parentAccountId=...
 *   → { code: "1002" }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { suggestNextAccountCode } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { GLAccountType } from '@/modules/accounting/types/gl.types';

const VALID_TYPES: GLAccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const accountType = String(req.query.accountType || '') as GLAccountType;
    if (!VALID_TYPES.includes(accountType)) {
      return apiResponse.badRequest(res, 'accountType must be asset|liability|equity|revenue|expense');
    }
    const accountSubtype = req.query.accountSubtype ? String(req.query.accountSubtype) : undefined;
    const parentAccountId = req.query.parentAccountId ? String(req.query.parentAccountId) : undefined;

    const code = await suggestNextAccountCode(companyId, { accountType, accountSubtype, parentAccountId });
    return apiResponse.success(res, { code });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to suggest next account code';
    log.error('Failed to suggest next account code', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

export default withAuth(withErrorHandler(handler));
