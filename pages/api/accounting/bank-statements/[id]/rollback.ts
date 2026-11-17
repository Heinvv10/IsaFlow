/**
 * POST /api/accounting/bank-statements/[id]/rollback
 * Flips status → 'rolled_back'. Only valid before commit.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { respondToStatementRefusal } from '@/lib/apiStatementExtraction';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { rollbackImport, ImportNotReadyError } from '@/modules/accounting/services/bank/bankStatementOcrService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);

  const { companyId } = req;
  const userId = req.user.id;
  const { id } = req.query as { id: string };
  if (!UUID.safeParse(id).success) return apiResponse.badRequest(res, 'Statement import id must be a valid UUID');

  try {
    await rollbackImport(companyId, id, userId);
    return apiResponse.success(res, { rolled_back: true });
  } catch (err) {
    if (respondToStatementRefusal(res, err)) return; // NOT_FOUND is a 404 (the import is not this company's, or gone)
    // Still being read, or failed to be: nothing was written, so 409 is safe.
    if (err instanceof ImportNotReadyError) return apiResponse.conflict(res, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
