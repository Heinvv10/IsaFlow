/**
 * POST /api/payroll/employees/:id/apply-package
 * Body: { packageId, effectiveFrom (YYYY-MM-DD) }
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
  applyPackageToEmployee,
  PayPackageNotFoundError,
} from '@/modules/accounting/services/payroll/payPackageService';

const Body = z.object({
  packageId: z.string().uuid(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing employee id');

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');

  try {
    const result = await applyPackageToEmployee(
      companyId, parsed.data.packageId, id, parsed.data.effectiveFrom, user.id,
    );
    return apiResponse.success(res, result);
  } catch (err) {
    if (err instanceof PayPackageNotFoundError) return apiResponse.notFound(res, err.message);
    return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Apply failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
