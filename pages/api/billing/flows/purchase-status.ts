/**
 * GET /api/billing/flows/purchase-status?id=<flow_purchase_id>
 *
 * Polled by the Stitch return-landing page to detect when the webhook has
 * credited the wallet.  Returns pending / succeeded / failed plus the flow
 * count so the UI can render a concrete success message without having to
 * re-fetch the wallet.
 */

import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getPurchaseStatus } from '@/modules/billing/services/flowWalletService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const id = typeof req.query.id === 'string' ? req.query.id : null;
  if (!id) return apiResponse.badRequest(res, 'id is required');

  const status = await getPurchaseStatus(req.companyId, id);
  if (!status) return apiResponse.notFound(res, 'Purchase');

  return apiResponse.success(res, status);
}

export default withAuth(withErrorHandler(handler));
