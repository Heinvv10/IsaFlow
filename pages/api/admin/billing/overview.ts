/**
 * Admin Billing Overview API
 * GET /api/admin/billing/overview — Platform-wide billing KPIs
 */

import type { NextApiResponse } from 'next';
import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { getBillingOverview } from '@/modules/admin/services/billingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const overview = await getBillingOverview();
      return apiResponse.success(res, overview);
    } catch (err) {
      log.error('Failed to get billing overview', { error: err }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to get billing overview');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withRole('super_admin')(withErrorHandler(handler as any) as any) as any);
