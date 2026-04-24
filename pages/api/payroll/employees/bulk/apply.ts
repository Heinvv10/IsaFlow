/**
 * POST /api/payroll/employees/bulk/apply
 * Body: { filter, update, effectiveFrom?, changeReason? }
 * Transactionally updates matching employees + writes history rows.
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
  applyBulkEmployeeUpdate,
  EmptyUpdateError,
  EmptyFilterError,
} from '@/modules/accounting/services/payroll/payrollBulkEmployeeService';

const Filter = z
  .object({
    department: z.string().nullable().optional(),
    costCentreId: z.string().uuid().nullable().optional(),
    employmentType: z.string().nullable().optional(),
  })
  .strict();

const Update = z
  .object({
    department: z.string().optional(),
    costCentreId: z.string().uuid().nullable().optional(),
    employmentType: z.string().optional(),
  })
  .strict();

const Body = z
  .object({
    filter: Filter,
    update: Update,
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    changeReason: z.string().max(500).optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');

  try {
    const opts: { effectiveFrom?: string; changeReason?: string } = {};
    if (parsed.data.effectiveFrom !== undefined) opts.effectiveFrom = parsed.data.effectiveFrom;
    if (parsed.data.changeReason !== undefined) opts.changeReason = parsed.data.changeReason;
    const result = await applyBulkEmployeeUpdate(
      companyId,
      parsed.data.filter,
      parsed.data.update,
      user.id,
      opts,
    );
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof EmptyFilterError || err instanceof EmptyUpdateError) {
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
