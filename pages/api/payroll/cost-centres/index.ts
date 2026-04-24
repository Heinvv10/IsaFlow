/**
 * GET  /api/payroll/cost-centres        - list (?activeOnly=1)
 * POST /api/payroll/cost-centres        - create
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
import {
  createCostCentre,
  listCostCentres,
} from '@/modules/accounting/services/payroll/costCentreService';

const CreateBody = z
  .object({
    code: z.string().min(1).max(30),
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
    try {
      const cc = await createCostCentre({
        companyId,
        code: parsed.data.code,
        name: parsed.data.name,
        parentId: parsed.data.parentId ?? null,
        notes: parsed.data.notes,
        userId: user.id,
      });
      return apiResponse.created(res, cc);
    } catch (err) {
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
