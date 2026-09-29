/**
 * Portal Invoice — Generate Token (internal, auth required)
 * POST /api/portal/invoice/generate
 * Body: { invoiceId: string }
 * Returns: { token, portalUrl }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withCsrf, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { isUuidParam } from '@/lib/validation';
import { log } from '@/lib/logger';
import { findOrMintInvoicePortalToken } from '@/modules/accounting/services/ar/portalTokenService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { invoiceId } = req.body as { invoiceId?: string };

  if (!invoiceId) {
    return apiResponse.badRequest(res, 'invoiceId is required');
  }
  if (!isUuidParam(invoiceId)) {
    return apiResponse.badRequest(res, 'invoiceId must be a UUID');
  }

  // K-101: the active company withAuth verified, not the user's default one.
  const companyId = (req as CompanyAuthedRequest).companyId;

  // R-155: one COALESCE UPDATE ... RETURNING, so a concurrent mint's token is kept, not overwritten.
  const minted = await findOrMintInvoicePortalToken(invoiceId, companyId);
  if (!minted) {
    return apiResponse.notFound(res, 'Invoice');
  }
  log.info('Portal token issued', { invoiceId }, 'Portal');

  return apiResponse.success(res, { token: minted.token, portalUrl: minted.url });
}

// R-157: the token is a permanent public credential, so minting is a write: CSRF-checked, and
// owner/admin/manager only. Both refuse before the first write (withAuth COMMITs a 4xx).
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
