/**
 * GET  /api/accounting/ar/invoice/[id]/portal-link
 * POST /api/accounting/ar/invoice/[id]/portal-link
 *
 * Internal, company-scoped. GET returns the invoice's public customer-facing
 * portal URL, or 404 when none has been minted; it never mints (R-157: a GET
 * passes withWriteAccess and withCsrf, so a minting GET let a viewer create a
 * permanent public credential). POST returns the existing token or mints one;
 * it is idempotent, so the link a bookkeeper emailed last week keeps working.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { isUuidParam } from '@/lib/validation';
import {
  findOrMintInvoicePortalToken,
  getInvoicePortalToken,
  portalUrl,
} from '@/modules/accounting/services/ar/portalTokenService';

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
  if (!isUuidParam(id)) {
    apiResponse.badRequest(res, 'Invoice id must be a UUID');
    return;
  }

  let link: { token: string; url: string } | null;
  if (req.method === 'GET') {
    const stored = await getInvoicePortalToken(id, companyId);
    link = stored ? { token: stored, url: portalUrl(stored) } : null;
  } else {
    link = await findOrMintInvoicePortalToken(id, companyId);
  }
  if (!link) {
    apiResponse.notFound(res, 'Portal link');
    return;
  }
  apiResponse.success(res, {
    token: link.token,
    url: link.url,
    pixelUrl: `${(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3101')}/api/portal/pixel/${link.token}`,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
