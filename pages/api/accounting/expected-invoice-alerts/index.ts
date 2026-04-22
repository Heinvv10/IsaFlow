/**
 * GET  /api/accounting/expected-invoice-alerts             — list alerts
 * GET  /api/accounting/expected-invoice-alerts?status=...  — filtered
 * POST /api/accounting/expected-invoice-alerts?action=detect-gaps — run gap scan
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listAlerts,
  detectGaps,
} from '@/modules/accounting/services/capture/missingInvoiceChaseService';
import type { ExpectedAlert } from '@/modules/accounting/services/capture/missingInvoiceChaseService';

const VALID_STATUSES: ReadonlyArray<ExpectedAlert['status']> = ['pending', 'chased', 'resolved', 'dismissed'];

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { status } = req.query as { status?: string };

    if (status && !VALID_STATUSES.includes(status as ExpectedAlert['status'])) {
      return apiResponse.badRequest(res, `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    const alerts = await listAlerts(companyId, status as ExpectedAlert['status'] | undefined);
    return apiResponse.success(res, alerts);
  }

  // ── POST /detect-gaps ────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.query as { action?: string };
    if (action !== 'detect-gaps') {
      return apiResponse.badRequest(res, 'Unknown action. Use ?action=detect-gaps');
    }

    log.info('Running detectGaps', { companyId }, 'expected-invoice-alerts');
    const result = await detectGaps(companyId);
    return apiResponse.success(res, result);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
