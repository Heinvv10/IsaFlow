/**
 * GET  /api/payroll/cost-centres        - list (?activeOnly=1)
 * POST /api/payroll/cost-centres        - create
 *
 * The create writes the same cost_centres rows as the accounting master, so it
 * goes through the same plan (dimensionMasterService): code / alias clash and
 * the ladder — a centre with a parent is a CC2 under an active CC1 or programme
 * of THIS company, one without is a CC1. A refusal is a 400 with its message.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  withCsrf,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import { getPayrollCostCentre, listCostCentres } from '@/modules/accounting/services/core/costCentreService';
import {
  applyCreateDimensionCostCentre, planCreateDimensionCostCentre,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterService';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';

const CreateBody = z
  .object({
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(120),
    parentId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: "Invalid UUID" }).optional().nullable(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
    const rows = await listCostCentres(companyId, { activeOnly });
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    const { code, name, parentId, notes } = parsed.data;
    try {
      const plan = await planCreateDimensionCostCentre(companyId, {
        code, name, notes, ccType: parentId ? 'cc2' : 'cc1', ...(parentId ? { parent: parentId } : {}),
      });
      const created = await applyCreateDimensionCostCentre(companyId, plan, user.id);
      return apiResponse.created(res, await getPayrollCostCentre(companyId, created.id));
    } catch (err) {
      if (isDimensionRefusal(err)) return apiResponse.badRequest(res, err.message);
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
