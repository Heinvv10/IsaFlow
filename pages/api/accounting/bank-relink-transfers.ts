/**
 * POST /api/accounting/bank-relink-transfers
 * Retroactively link imported bank transactions to existing JEs on other
 * bank accounts (covers both 'transfer' and 'account' allocation types).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { relinkTransferCounterparts } from '@/modules/accounting/services/bank/bankTransferLinkService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.badRequest(res, 'Method not allowed');

  const { companyId } = req as CompanyAuthedRequest;
  const { bankAccountId } = req.body as { bankAccountId?: string };
  if (!bankAccountId) return apiResponse.badRequest(res, 'bankAccountId is required');

  const count = await relinkTransferCounterparts(companyId, bankAccountId);
  return apiResponse.success(res, { linked: count });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
