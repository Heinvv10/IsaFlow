/**
 * The header bell's feed (budgets P5 spec §4/§5): GET → { items: the latest 20 of the caller's own
 * notifications in the active company, newest first; unread: their unread count }.
 * Any member. Company and user come from the session, never the request; every query names both.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { listNotifications } from '@/modules/accounting/services/notifications/userNotificationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  return apiResponse.success(res, await listNotifications(companyId, userId));
}

export default withAuth(withErrorHandler(handler));
