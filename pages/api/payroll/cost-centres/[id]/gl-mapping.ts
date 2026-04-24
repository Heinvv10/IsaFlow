/**
 * PUT    /api/payroll/cost-centres/:id/gl-mapping   { expenseAccountId }
 * DELETE /api/payroll/cost-centres/:id/gl-mapping
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
  upsertCostCentreGlMapping,
  deleteCostCentreGlMapping,
} from '@/modules/accounting/services/payroll/costCentreGlMappingService';

const PutBody = z.object({ expenseAccountId: z.string().uuid() }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing cost centre id');

  if (req.method === 'PUT') {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    try {
      await upsertCostCentreGlMapping(companyId, id, parsed.data.expenseAccountId, user.id);
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      return apiResponse.badRequestFromError(res, err, 'Save failed');
    }
  }

  if (req.method === 'DELETE') {
    await deleteCostCentreGlMapping(companyId, id);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
