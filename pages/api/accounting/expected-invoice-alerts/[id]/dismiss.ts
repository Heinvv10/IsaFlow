/**
 * POST /api/accounting/expected-invoice-alerts/[id]/dismiss
 * Body: { reason: string }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { dismissAlert } from '@/modules/accounting/services/capture/missingInvoiceChaseService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const alertId = req.query.id as string;
  const userId = (req as CompanyAuthedRequest & { user?: { id?: string } }).user?.id ?? '';

  if (!alertId) return apiResponse.badRequest(res, 'alertId is required');

  const { reason } = (req.body ?? {}) as { reason?: string };
  if (!reason?.trim()) return apiResponse.badRequest(res, 'reason is required');

  await dismissAlert(companyId, alertId, reason.trim(), userId);

  return apiResponse.success(res, { dismissed: true });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
