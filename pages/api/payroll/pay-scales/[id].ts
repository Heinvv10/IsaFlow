/**
 * PATCH /api/payroll/pay-scales/:id   — update
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
  updatePayScale,
  PayScaleNotFoundError,
  InvalidSalaryBandError,
} from '@/modules/accounting/services/payroll/payScaleService';

const PatchBody = z
  .object({
    code: z.string().min(1).max(30).optional(),
    name: z.string().min(1).max(120).optional(),
    gradeLevel: z.number().int().min(0).max(100).optional(),
    minSalary: z.number().nonnegative().optional(),
    midSalary: z.number().nonnegative().optional(),
    maxSalary: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'PATCH') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PATCH']);
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing id');

  const parsed = PatchBody.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');

  try {
    await updatePayScale(companyId, id, parsed.data);
    return apiResponse.success(res, { updated: true });
  } catch (err) {
    if (err instanceof PayScaleNotFoundError) return apiResponse.notFound(res, err.message);
    if (err instanceof InvalidSalaryBandError) return apiResponse.badRequest(res, err.message);
    return apiResponse.badRequestFromError(res, err, 'Update failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
