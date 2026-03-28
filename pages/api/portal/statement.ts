/**
 * Client Portal — Statement API
 * GET — get client statement
 * Requires portal session cookie with matching clientId
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getClientStatement } from '@/modules/accounting/services/portalService';
import cookie from 'cookie';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  // Validate portal session
  const cookies = cookie.parse(req.headers.cookie || '');
  const portalSession = cookies.portal_session;
  if (!portalSession) {
    return apiResponse.unauthorized(res, 'Portal authentication required');
  }

  let sessionData: { clientId: string };
  try {
    sessionData = JSON.parse(decodeURIComponent(portalSession));
  } catch {
    return apiResponse.unauthorized(res, 'Invalid portal session');
  }

  const clientId = req.query.clientId as string;
  if (!clientId) {
    return apiResponse.badRequest(res, 'clientId is required');
  }

  // Enforce tenant isolation
  if (sessionData.clientId !== clientId) {
    return apiResponse.forbidden(res, 'Access denied — clientId mismatch');
  }

  const asOfDate = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
  const statement = await getClientStatement(clientId, asOfDate);
  return apiResponse.success(res, statement);
}

export default withErrorHandler(handler);
