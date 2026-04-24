/**
 * GET /api/admin/billing/payg/[companyId]/wallet
 * Admin view: wallet + recent ledger (100 entries max).
 */

import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { getWallet, listLedger } from '@/modules/billing/services/flowWalletService';
import type { PlatformAdminRequest } from '@/lib/auth';

async function handler(req: PlatformAdminRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req.query;
  if (typeof companyId !== 'string' || !companyId) {
    return apiResponse.badRequest(res, 'companyId is required');
  }

  const [wallet, ledger] = await Promise.all([
    getWallet(companyId),
    listLedger(companyId, 100),
  ]);

  return apiResponse.success(res, { wallet, ledger });
}

export default withAdmin(handler);
