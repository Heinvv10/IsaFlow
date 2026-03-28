/**
 * Client Portal — Statement API
 * GET — get client statement
 * Requires signed portal session cookie (JWT)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getClientStatement } from '@/modules/accounting/services/portalService';
import { jwtVerify } from 'jose';
import cookie from 'cookie';

const PORTAL_SECRET = new TextEncoder().encode(
  (process.env.JWT_SECRET || 'fallback-secret') + '-portal'
);

async function getPortalSession(req: NextApiRequest): Promise<{ clientId: string } | null> {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.portal_session;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, PORTAL_SECRET);
    return { clientId: payload.clientId as string };
  } catch {
    return null;
  }
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

  // Enforce tenant isolation
  if (session.clientId !== clientId) {
    return apiResponse.forbidden(res, 'Access denied — clientId mismatch');
  }

  const asOfDate = (req.query.asOf as string) || new Date().toISOString().slice(0, 10);
  const statement = await getClientStatement(clientId, asOfDate);
  return apiResponse.success(res, statement);
}

export default withErrorHandler(handler);
