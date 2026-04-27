/**
 * POST /api/accounting/bank-relink-transfers
 * Retroactively link imported bank transactions to existing JEs on other
 * bank accounts (covers both 'transfer' and 'account' allocation types).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { relinkTransferCounterparts } from '@/modules/accounting/services/bank/bankTransferLinkService';

const BodySchema = z.object({ bankAccountId: UUID }).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.badRequest(res, 'Method not allowed');

  const { companyId } = req as CompanyAuthedRequest;
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const count = await relinkTransferCounterparts(companyId, parsed.data.bankAccountId);
  return apiResponse.success(res, { linked: count });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
