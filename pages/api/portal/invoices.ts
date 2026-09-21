/**
 * Client Portal — Invoices API
 * GET — list invoices for the authenticated portal user's client
 * Requires signed portal session cookie (JWT)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getClientInvoices } from '@/modules/accounting/services/ar/portalService';
import { resolvePortalSession } from '@/modules/accounting/services/ar/portalSession';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const session = await resolvePortalSession(req);
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

  const invoices = await getClientInvoices(clientId, session.companyId);
  if (!invoices) {
    return apiResponse.notFound(res, 'Customer', clientId);
  }
  return apiResponse.success(res, { items: invoices });
}

export default withErrorHandler(handler);
