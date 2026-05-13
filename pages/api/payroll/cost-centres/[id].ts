/**
 * PATCH  /api/payroll/cost-centres/:id  - update fields
 * DELETE /api/payroll/cost-centres/:id  - deactivate (soft delete)
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
  updateCostCentre,
  deactivateCostCentre,
  CostCentreNotFoundError,
} from '@/modules/accounting/services/core/costCentreService';

const PatchBody = z
  .object({
    code: z.string().min(1).max(30).optional(),
    name: z.string().min(1).max(120).optional(),
    parentId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: "Invalid UUID" }).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing cost centre id');

  try {
    if (req.method === 'PATCH') {
      const parsed = PatchBody.safeParse(req.body);
      if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      await updateCostCentre(companyId, id, parsed.data);
      return apiResponse.success(res, { updated: true });
    }

    if (req.method === 'DELETE') {
      await deactivateCostCentre(companyId, id);
      return apiResponse.success(res, { deactivated: true });
    }

    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH', 'DELETE']);
  } catch (err) {
    if (err instanceof CostCentreNotFoundError) return apiResponse.notFound(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
