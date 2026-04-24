/**
 * GET  /api/payroll/pay-packages   — list (?activeOnly=1)
 * POST /api/payroll/pay-packages   — create
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
  createPayPackage,
  listPayPackages,
} from '@/modules/accounting/services/payroll/payPackageService';

const CreateBody = z
  .object({
    code: z.string().min(1).max(30),
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional(),
  })
  .strict();

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
    const rows = await listPayPackages(companyId, { activeOnly });
    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
    try {
      const pkg = await createPayPackage({
        companyId,
        code: parsed.data.code,
        name: parsed.data.name,
        ...(parsed.data.description !== undefined && { description: parsed.data.description }),
        userId: user.id,
      });
      return apiResponse.created(res, pkg);
    } catch (err) {
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
