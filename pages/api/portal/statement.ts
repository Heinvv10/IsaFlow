/**
 * Client Portal — Statement API
 * GET — get client statement
 * Requires signed portal session cookie (JWT)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getClientStatement } from '@/modules/accounting/services/ar/portalService';
import { verifyArPortalToken, type ArPortalSession } from '@/lib/auth/arPortalJwt';
import cookie from 'cookie';

async function getPortalSession(req: NextApiRequest): Promise<ArPortalSession | null> {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.portal_session;
  if (!token) return null;
  return verifyArPortalToken(token);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const session = await getPortalSession(req);
  if (!session) {
    return apiResponse.unauthorized(res, 'Portal authentication required');
  }

  const clientId = req.query.clientId as string;
  if (!clientId) {
    return apiResponse.badRequest(res, 'clientId is required');
  }

  if (session.clientId !== clientId) {
    return apiResponse.forbidden(res, 'Access denied — clientId mismatch');
  }

  const asOfDate = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
  const statement = await getClientStatement(clientId, session.companyId, asOfDate);
  return apiResponse.success(res, statement);
}

export default withErrorHandler(handler);
