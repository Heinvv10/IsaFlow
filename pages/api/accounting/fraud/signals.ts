/**
 * GET /api/accounting/fraud/signals
 * Tenant-visible cross-tenant fraud alerts (Phase 11).
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listAlerts } from '@/modules/accounting/services/capture/supplierGraphService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const { companyId } = req;
  const status = req.query.status as string | undefined;
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10)));
  const alerts = await listAlerts(companyId, { status, limit });
  return apiResponse.success(res, { alerts, total: alerts.length });
}

export default withAuth(withErrorHandler(handler));
