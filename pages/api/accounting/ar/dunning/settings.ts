/**
 * GET /api/accounting/ar/dunning/settings
 * PUT /api/accounting/ar/dunning/settings
 *   body: { auto_send_enabled?: boolean, min_outstanding_zar?: number }
 *
 * Per-company auto-send opt-in. Default (row absent) is opt-out.
 * PRD-06 Phase 5. Company-scoped, write-only (manager+).
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import {
  getSettings,
  updateSettings,
} from '@/modules/accounting/services/ar/dunningAdmin';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const settings = await getSettings(companyId);
    apiResponse.success(res, { settings });
    return;
  }

  if (req.method === 'PUT') {
    const body = req.body ?? {};
    const patch: { auto_send_enabled?: boolean; min_outstanding_zar?: number } = {};

    if (typeof body.auto_send_enabled === 'boolean') {
      patch.auto_send_enabled = body.auto_send_enabled;
    }
    if (body.min_outstanding_zar !== undefined) {
      const n = Number(body.min_outstanding_zar);
      if (!Number.isFinite(n) || n < 0) {
        apiResponse.badRequest(res, 'min_outstanding_zar must be ≥ 0');
        return;
      }
      patch.min_outstanding_zar = n;
    }

    const settings = await updateSettings(companyId, patch);
    apiResponse.success(res, { settings });
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
