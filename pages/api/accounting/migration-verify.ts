/**
 * Migration Verify API
 * POST /api/accounting/migration-verify
 * Body: { sourceAccounts: ParsedAccount[] }
 * Returns: VerifyEntry[]
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { verifyBalances } from '@/modules/accounting/services/migrationExecuteService';
import type { ParsedAccount } from '@/modules/accounting/services/migrationParserService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { sourceAccounts } = req.body as { sourceAccounts: ParsedAccount[] };

  if (!Array.isArray(sourceAccounts)) {
    return apiResponse.badRequest(res, 'sourceAccounts must be an array');
  }

  const results = await verifyBalances(companyId, sourceAccounts);
  const matched = results.filter(r => r.matched).length;

  return apiResponse.success(res, { results, matched, total: results.length, allMatched: matched === results.length });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
