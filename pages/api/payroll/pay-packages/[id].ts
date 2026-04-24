/**
 * GET   /api/payroll/pay-packages/:id          — header + components
 * PATCH /api/payroll/pay-packages/:id          — update header
 * PUT   /api/payroll/pay-packages/:id          — replace components
 *   PUT body: { components: [{componentId, amount, isRecurring}] }
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
  getPayPackage,
  updatePayPackage,
  setPackageComponents,
  PayPackageNotFoundError,
} from '@/modules/accounting/services/payroll/payPackageService';

const PatchBody = z
  .object({
    code: z.string().min(1).max(30).optional(),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const PutBody = z
  .object({
    components: z
      .array(
        z.object({
          componentId: z.string().uuid(),
          amount: z.number().nonnegative(),
          isRecurring: z.boolean(),
        }),
      )
      .max(100),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const id = String(req.query.id ?? '');
  if (!id) return apiResponse.badRequest(res, 'Missing id');

  if (req.method === 'GET') {
    const pkg = await getPayPackage(companyId, id);
    if (!pkg) return apiResponse.notFound(res, 'PayPackage', id);
    return apiResponse.success(res, pkg);
  }

  if (req.method === 'PATCH') {
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    try {
      await updatePayPackage(companyId, id, parsed.data);
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      if (err instanceof PayPackageNotFoundError) return apiResponse.notFound(res, err.message);
      throw err;
    }
  }

  if (req.method === 'PUT') {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    try {
      await setPackageComponents(companyId, id, parsed.data.components);
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      if (err instanceof PayPackageNotFoundError) return apiResponse.notFound(res, err.message);
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Save failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PATCH', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
