/**
 * GET /api/accounting/evidence/trial-balance/[accountId]
 * Returns GL line evidence for a specific account, with optional date range.
 * Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, limit=N, cost_centre_id=UUID,
 * business_unit_id=UUID. Dimension filters are cumulative.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { sql } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { resolveAccountEvidence } from '@/modules/accounting/services/core/evidenceGraphService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const costCentreId = req.query.cost_centre_id;
  if (costCentreId !== undefined && (typeof costCentreId !== 'string' || !UUID_RE.test(costCentreId))) {
    return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
  }
  const businessUnitId = req.query.business_unit_id;
  if (businessUnitId !== undefined && (typeof businessUnitId !== 'string' || !UUID_RE.test(businessUnitId))) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }

  const { companyId } = req;
  let accountId = req.query.accountId;
  if (typeof accountId !== 'string' || !accountId) return apiResponse.badRequest(res, 'accountId is required');

  // Financial statement rows identify accounts by code; UUID callers remain supported.
  if (!UUID_RE.test(accountId)) {
    const [account] = await sql`SELECT id FROM gl_accounts
      WHERE company_id = ${companyId}::uuid AND account_code = ${accountId} LIMIT 1`;
    if (!account) return apiResponse.notFound(res, 'Account not found');
    accountId = String(account.id);
  }

  const { from, to, limit: limitStr } = req.query as Record<string, string | undefined>;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  if (limitStr && (isNaN(limit!) || limit! < 1 || limit! > 1000)) {
    return apiResponse.badRequest(res, 'limit must be an integer between 1 and 1000');
  }

  log.info('Fetching account evidence', { companyId, accountId, from, to, limit }, 'evidence-api');

  const rows = await resolveAccountEvidence(companyId, accountId, {
    costCentreId,
    businessUnitId,
    fromDate: from,
    toDate: to,
    limit,
  });

  return apiResponse.success(res, { rows, count: rows.length });
}

export default withAuth(withErrorHandler(handler));
