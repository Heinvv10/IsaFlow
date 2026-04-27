/**
 * GET  /api/accounting/capture/inbox-address  — return current email inbox address
 * POST /api/accounting/capture/inbox-address  — regenerate email inbox address
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  getOrCreateEmailInbox,
  regenerateEmailAddress,
} from '@/modules/accounting/services/capture/captureInboxService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user?.id;

  if (req.method === 'GET') {
    const inbox = await getOrCreateEmailInbox(companyId, userId);
    return apiResponse.success(res, { inbox });
  }

  if (req.method === 'POST') {
    const inbox = await regenerateEmailAddress(companyId, userId);
    return apiResponse.success(res, { inbox });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
