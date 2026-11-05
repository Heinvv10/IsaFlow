/**
 * Portal Invoice API — Public, token-based (no auth required)
 * GET /api/portal/invoice/[token] — fetch invoice for public view
 *
 * R-156: the authenticated POST that minted a token here is gone. It duplicated
 * POST /api/portal/invoice/generate, which is the one mint route.
 * The lookup and the read receipt live in portalInvoiceService (the invoice page calls it too).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { loadPortalInvoice } from '@/modules/accounting/services/ar/portalInvoiceService';

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const data = await loadPortalInvoice(req.query.token as string, req);
  if (!data) return apiResponse.notFound(res, 'Invoice');
  return apiResponse.success(res, data);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
}

export default withErrorHandler(handler);
