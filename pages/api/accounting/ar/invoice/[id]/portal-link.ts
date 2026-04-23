/**
 * GET  /api/accounting/ar/invoice/[id]/portal-link
 * POST /api/accounting/ar/invoice/[id]/portal-link
 *
 * Internal, company-scoped. Returns (and mints if absent) the public
 * customer-facing portal URL for an invoice. GET and POST are both
 * idempotent — we reuse the existing portal_token when present so the
 * link a bookkeeper emailed last week keeps working.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { getOrMintInvoicePortalToken } from '@/modules/accounting/services/ar/portalTokenService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET' && req.method !== 'POST') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
    return;
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    apiResponse.badRequest(res, 'Invoice id is required');
    return;
  }

  const minted = await getOrMintInvoicePortalToken(id, companyId);
  apiResponse.success(res, {
    token: minted.token,
    url: minted.url,
    pixelUrl: `${(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3101')}/api/portal/pixel/${minted.token}`,
  });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
