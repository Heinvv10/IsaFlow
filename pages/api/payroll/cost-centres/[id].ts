/**
 * PATCH  /api/payroll/cost-centres/:id  - update fields
 * DELETE /api/payroll/cost-centres/:id  - deactivate (soft delete)
 *
 * Both edit the same cost_centres rows as the accounting master, so both go
 * through its plan (dimensionMasterEdit): parent of this company only, no loop,
 * no carried CC2 moved to another FNO, no code / alias clash, no deactivation
 * with active children or while a default names it. A refusal is a 400 with its
 * message; an edit that changes nothing (deactivating an inactive centre) succeeds.
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
  applyUpdateDimensionCostCentre, planUpdateDimensionCostCentre, type UpdateDimensionCostCentreInput,
} from '@/modules/accounting/services/gl/dimensions/dimensionMasterEdit';
import { isDimensionRefusal } from '@/modules/accounting/services/gl/dimensions/dimensionTypes';
import { UUID_RE } from '@/lib/validation';

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
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!UUID_RE.test(id)) return apiResponse.badRequest(res, 'Missing or invalid cost centre id');

  let input: UpdateDimensionCostCentreInput;
  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    const { parentId, ...rest } = parsed.data;
    input = { ...rest, ...(parentId !== undefined ? { parent: parentId } : {}) };
  } else if (req.method === 'DELETE') {
    input = { isActive: false };
  } else {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH', 'DELETE']);
  }

  try {
    const plan = await planUpdateDimensionCostCentre(companyId, id, input);
    await applyUpdateDimensionCostCentre(companyId, plan, user.id);
  } catch (err) {
    if (isDimensionRefusal(err)) return apiResponse.badRequest(res, err.message);
    throw err;
  }
  return apiResponse.success(res, req.method === 'PATCH' ? { updated: true } : { deactivated: true });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
