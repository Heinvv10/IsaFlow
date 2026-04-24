/**
 * GET  /api/payroll/employees/:id/cost-allocations
 * PUT  /api/payroll/employees/:id/cost-allocations
 *   body: { allocations: [{ costCentreId: uuid, percentage: number }] }
 *   Replaces the full allocation set atomically. Empty array clears.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  withWriteAccess,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  getEmployeeCostAllocations,
  setEmployeeCostAllocations,
  AllocationSumError,
  DuplicateCostCentreError,
} from '@/modules/accounting/services/payroll/payrollCostAllocationService';

const PutBody = z
  .object({
    allocations: z
      .array(
        z.object({
          costCentreId: z.string().uuid(),
          percentage: z.number().positive().max(100),
        }),
      )
      .max(50),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing employee id');

  if (req.method === 'GET') {
    const rows = await getEmployeeCostAllocations(companyId, id);
    return apiResponse.success(res, rows);
  }

  if (req.method === 'PUT') {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    try {
      await setEmployeeCostAllocations(companyId, id, parsed.data.allocations, user.id);
      const rows = await getEmployeeCostAllocations(companyId, id);
      return apiResponse.success(res, rows);
    } catch (err) {
      if (err instanceof AllocationSumError) return apiResponse.badRequest(res, err.message);
      if (err instanceof DuplicateCostCentreError) return apiResponse.badRequest(res, err.message);
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Save failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
