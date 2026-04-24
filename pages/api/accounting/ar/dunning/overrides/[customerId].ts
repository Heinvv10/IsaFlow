/**
 * GET    /api/accounting/ar/dunning/overrides/[customerId] — fetch one
 * DELETE /api/accounting/ar/dunning/overrides/[customerId] — remove override
 *
 * PRD-06 Phase 5 follow-up. Company-scoped.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import {
  getOverride,
  deleteOverride,
} from '@/modules/accounting/services/ar/dunningOverridesService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : '';
  if (!customerId) {
    apiResponse.badRequest(res, 'customerId is required in path');
    return;
  }

  if (req.method === 'GET') {
    const override = await getOverride(companyId, customerId);
    if (!override) {
      apiResponse.notFound(res, 'Customer override', customerId);
      return;
    }
    apiResponse.success(res, { override });
    return;
  }

  if (req.method === 'DELETE') {
    const ok = await deleteOverride(companyId, customerId);
    if (!ok) {
      apiResponse.notFound(res, 'Customer override', customerId);
      return;
    }
    apiResponse.success(res, { deleted: true });
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'DELETE']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
