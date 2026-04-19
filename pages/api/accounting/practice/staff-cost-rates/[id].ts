/**
 * Practice Staff Cost Rate Detail API
 * GET    /api/accounting/practice/staff-cost-rates/[id]  - Get a single cost rate
 * PUT    /api/accounting/practice/staff-cost-rates/[id]  - Update a cost rate
 * DELETE /api/accounting/practice/staff-cost-rates/[id]  - Delete a cost rate
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  getCostRate,
  updateCostRate,
  deleteCostRate,
} from '@/modules/accounting/services/practice/practiceCostRateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;

  if (req.method === 'GET') {
    const record = await getCostRate(companyId, id as string);
    if (!record) return apiResponse.notFound(res, 'Cost rate not found');
    return apiResponse.success(res, record);
  }

  if (req.method === 'PUT') {
    const updated = await updateCostRate(companyId, id as string, req.body as Record<string, unknown>);
    return apiResponse.success(res, updated);
  }

  if (req.method === 'DELETE') {
    await deleteCostRate(companyId, id as string);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
