/**
 * PATCH /api/payroll/employees/:id/occupational-level
 * Body: { occupationalLevelId: string | null }
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
import { assignEmployeeOccupationalLevel } from '@/modules/accounting/services/payroll/equityReportService';

const Body = z.object({ occupationalLevelId: z.string().uuid().nullable() }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'PATCH') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing employee id');

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, 'occupationalLevelId required (string | null)');

  try {
    await assignEmployeeOccupationalLevel(companyId, id, parsed.data.occupationalLevelId, user.id);
    return apiResponse.success(res, { updated: true });
  } catch (err) {
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Assign failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
