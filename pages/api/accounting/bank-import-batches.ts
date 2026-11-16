/**
 * Bank Import Batches API
 * GET /api/accounting/bank-import-batches?bankAccountId=<uuid>
 * The bank account's import batches, newest STATEMENT first (listImportBatches, order 'statement_date'), for the
 * Statement Balance Widget: opening/closing balances, why a batch has none (balanceSource), and the live line count.
 * A bankAccountId that is not a UUID is a 400; a failed read throws, so it is a 500 rather than an empty list.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { UUID } from '@/lib/schemas/common';
import { listImportBatches } from '@/modules/accounting/services/bank/bankImportBatchQueryService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const bankAccountId = UUID.safeParse(req.query.bankAccountId);
  if (!bankAccountId.success) {
    return apiResponse.badRequest(res, 'bankAccountId must be a valid UUID');
  }

  const batches = await listImportBatches(companyId, { bankAccountId: bankAccountId.data, order: 'statement_date' });
  return apiResponse.success(res, { batches });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
