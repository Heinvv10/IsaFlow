/**
 * GET /api/billing/flows/ledger — paginated ledger entries for this company.
 * Cursor-based pagination via `?cursor=<ISO createdAt>&limit=N`.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { listLedger } from '@/modules/billing/services/flowWalletService';
import { getCompanyPlan } from '@/lib/billing/getCompanyPlan';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const plan = await getCompanyPlan(req.companyId);
  if (!plan || plan.planCode !== 'payg') {
    return apiResponse.forbidden(res, 'Flow ledger is only available on the Pay-As-You-Go plan');
  }

  const limitParam = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(200, limitParam)) : 50;

  let cursor: Date | undefined;
  if (typeof req.query.cursor === 'string' && req.query.cursor.trim()) {
    const d = new Date(req.query.cursor);
    if (!Number.isNaN(d.getTime())) cursor = d;
  }

  const entries = await listLedger(req.companyId, limit, cursor);
  const nextCursor = entries.length === limit ? entries[entries.length - 1]!.createdAt.toISOString() : null;
  return apiResponse.success(res, { entries, nextCursor });
}

export default withAuth(withErrorHandler(handler));
