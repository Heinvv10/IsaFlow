/**
 * PATCH /api/payroll/employees/:id/cost-centre
 * Body: { costCentreId: string | null }
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
  assignEmployeeCostCentre,
  CostCentreNotFoundError,
} from '@/modules/accounting/services/payroll/costCentreService';

const Body = z.object({ costCentreId: z.string().uuid().nullable() }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'PATCH') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  }
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing employee id');

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, 'costCentreId required (string | null)');

  try {
    await assignEmployeeCostCentre(companyId, id, parsed.data.costCentreId, user.id);
    return apiResponse.success(res, { updated: true });
  } catch (err) {
    if (err instanceof CostCentreNotFoundError) return apiResponse.notFound(res, err.message);
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Assign failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
