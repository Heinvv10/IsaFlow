/**
 * Client Portal — Invoices API
 * GET — list invoices for the authenticated portal user's client
 * Requires signed portal session cookie (JWT)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getClientInvoices } from '@/modules/accounting/services/portalService';
import { jwtVerify } from 'jose';
import cookie from 'cookie';

const PORTAL_SECRET = new TextEncoder().encode(
  (() => { if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required'); return process.env.JWT_SECRET + '-portal'; })()
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

  // Enforce tenant isolation — user can only access their own client data
  if (session.clientId !== clientId) {
    return apiResponse.forbidden(res, 'Access denied — clientId mismatch');
  }

  const invoices = await getClientInvoices(clientId);
  return apiResponse.success(res, { items: invoices });
}

export default withErrorHandler(handler);
