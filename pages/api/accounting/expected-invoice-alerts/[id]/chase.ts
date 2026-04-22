/**
 * POST /api/accounting/expected-invoice-alerts/[id]/chase
 * Sends a chase email for the given alert.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sendEmailChase } from '@/modules/accounting/services/capture/missingInvoiceChaseService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const alertId = req.query.id as string;
  const userId = (req as CompanyAuthedRequest & { user?: { id?: string } }).user?.id ?? '';

  if (!alertId) return apiResponse.badRequest(res, 'alertId is required');

  const result = await sendEmailChase(companyId, alertId, userId);

  if (!result.sent) {
    return apiResponse.badRequest(res, result.reason ?? 'Chase email could not be sent');
  }

  return apiResponse.success(res, { sent: true });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
