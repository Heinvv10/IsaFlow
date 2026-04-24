/**
 * PATCH /api/payroll/employees/:id/pay-scale
 * Body: { payScaleId: string | null }
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
  assignEmployeePayScale,
  PayScaleNotFoundError,
} from '@/modules/accounting/services/payroll/payScaleService';

const Body = z.object({ payScaleId: z.string().uuid().nullable() }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'PATCH') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing employee id');

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, 'payScaleId required (string | null)');

  try {
    await assignEmployeePayScale(companyId, id, parsed.data.payScaleId, user.id);
    return apiResponse.success(res, { updated: true });
  } catch (err) {
    if (err instanceof PayScaleNotFoundError) return apiResponse.notFound(res, err.message);
    return apiResponse.badRequestFromError(res, err, 'Assign failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
