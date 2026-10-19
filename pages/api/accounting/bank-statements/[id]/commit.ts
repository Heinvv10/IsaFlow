/**
 * POST /api/accounting/bank-statements/[id]/commit
 * Inserts all non-duplicate rows into bank_transactions and marks the import committed.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { commitImport, ImportNotReadyError } from '@/modules/accounting/services/bank/bankStatementOcrService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);

  const { companyId } = req;
  const userId = req.user.id;
  const { id } = req.query as { id: string };

  try {
    const result = await commitImport(companyId, id, userId);
    return apiResponse.success(res, result);
  } catch (err) {
    // Still being read, or failed to be: nothing was written, so 409 is safe.
    if (err instanceof ImportNotReadyError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
