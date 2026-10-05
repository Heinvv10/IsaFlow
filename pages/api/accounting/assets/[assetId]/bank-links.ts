/**
 * GET /api/accounting/assets/:assetId/bank-links
 * The bank lines linked to this asset or to one of its fuel / service records (mig 853) — the asset page's
 * "Linked bank transactions" list. An asset that is missing or another company's is 404 — one answer for both.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { UUID } from '@/lib/schemas/common';
import { listAssetBankLinks } from '@/modules/accounting/services/items/assetBankLinksService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const assetId = UUID.safeParse(req.query.assetId);
  if (!assetId.success) return apiResponse.notFound(res, 'Asset');
  const rows = await listAssetBankLinks(req.companyId, assetId.data);
  return rows ? apiResponse.success(res, rows) : apiResponse.notFound(res, 'Asset');
}

export default withAuth(withErrorHandler(handler as Parameters<typeof withErrorHandler>[0]));
