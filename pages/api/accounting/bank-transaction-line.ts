/** GET /api/accounting/bank-transaction-line?id=<uuid>: one bank line of the active company (404 otherwise). */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { UUID } from '@/lib/schemas/common';
import { getBankTransactionById } from '@/modules/accounting/services/bank/bankTxSingleLine';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const id = UUID.safeParse(req.query.id);
  if (!id.success) return apiResponse.badRequest(res, 'id is required');
  const line = await getBankTransactionById(req.companyId, id.data);
  return line ? apiResponse.success(res, line) : apiResponse.notFound(res, 'Bank line');
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
