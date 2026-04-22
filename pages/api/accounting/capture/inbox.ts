/**
 * GET /api/accounting/capture/inbox
 * Returns pending capture events with joined document data.
 * Optional query param: ?status=extracted
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { listPendingEvents } from '@/modules/accounting/services/capture/captureQueryService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  }

  const { companyId } = req;
  const status = req.query.status as string | undefined;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10)));

  const events = await listPendingEvents(companyId, limit, status);

  return apiResponse.success(res, { events, total: events.length });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
