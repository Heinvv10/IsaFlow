/**
 * GET /api/accounting/evidence/trial-balance/[accountId]
 * Returns GL line evidence for a specific account, with optional date range.
 * Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, limit=N
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { resolveAccountEvidence } from '@/modules/accounting/services/core/evidenceGraphService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);

  const { companyId } = req;
  const accountId = req.query.accountId as string;
  if (!accountId) return apiResponse.badRequest(res, 'accountId is required');

  const { from, to, limit: limitStr } = req.query as Record<string, string | undefined>;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  if (limitStr && (isNaN(limit!) || limit! < 1 || limit! > 1000)) {
    return apiResponse.badRequest(res, 'limit must be an integer between 1 and 1000');
  }

  log.info('Fetching account evidence', { companyId, accountId, from, to, limit }, 'evidence-api');

  const rows = await resolveAccountEvidence(companyId, accountId, {
    fromDate: from,
    toDate: to,
    limit,
  });

  return apiResponse.success(res, { rows, count: rows.length });
}

export default withAuth(withErrorHandler(handler));
