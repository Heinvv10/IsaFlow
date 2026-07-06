/**
 * Close Agent v1 — company accuracy stats (proposed vs accepted).
 *
 * GET /api/accounting/close-run/accuracy
 *
 * Honesty in-product: shows how often the agent's auto_post proposals were
 * accepted (posted) vs rejected across every close run for the company.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getAccuracy } from '@/modules/accounting/services/gl/closeRun/closeRunService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const accuracy = await getAccuracy(companyId);
  return apiResponse.success(res, accuracy);
}

export default withAuth(withErrorHandler(handler));
