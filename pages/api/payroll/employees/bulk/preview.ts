/**
 * POST /api/payroll/employees/bulk/preview
 * Body: { filter: BulkFilter, update: BulkUpdate }
 * Returns { matchCount, sample: [{ id, employeeNumber, firstName, lastName, changes }] }
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
  previewBulkEmployeeUpdate,
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

const Body = z.object({ filter: Filter, update: Update }).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
  try {
    const preview = await previewBulkEmployeeUpdate(companyId, parsed.data.filter, parsed.data.update);
    return apiResponse.success(res, preview);
  } catch (err) {
    if (err instanceof EmptyFilterError || err instanceof EmptyUpdateError) {
      return apiResponse.badRequest(res, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(handler)));
