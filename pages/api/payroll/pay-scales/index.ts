/**
 * GET  /api/payroll/pay-scales   — list (?activeOnly=1)
 * POST /api/payroll/pay-scales   — create
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
  createPayScale,
  listPayScales,
  InvalidSalaryBandError,
} from '@/modules/accounting/services/payroll/payScaleService';

const CreateBody = z
  .object({
    code: z.string().min(1).max(30),
    name: z.string().min(1).max(120),
    gradeLevel: z.number().int().min(0).max(100),
    minSalary: z.number().nonnegative(),
    midSalary: z.number().nonnegative(),
    maxSalary: z.number().nonnegative(),
    currency: z.string().length(3).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
    const rows = await listPayScales(companyId, { activeOnly });
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    try {
      const scale = await createPayScale({
        companyId,
        code: parsed.data.code,
        name: parsed.data.name,
        gradeLevel: parsed.data.gradeLevel,
        minSalary: parsed.data.minSalary,
        midSalary: parsed.data.midSalary,
        maxSalary: parsed.data.maxSalary,
        ...(parsed.data.currency !== undefined && { currency: parsed.data.currency }),
        ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
        userId: user.id,
      });
      return apiResponse.created(res, scale);
    } catch (err) {
      if (err instanceof InvalidSalaryBandError) return apiResponse.badRequest(res, err.message);
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
