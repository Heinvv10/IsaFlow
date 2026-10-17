/**
 * POST /api/accounting/bank-statements/[id]/retry
 * Reads a failed (or interrupted) statement import again, in the background. Answers with the
 * import, 'extracting'. 409 if it is not failed, is still being read, or has too many pages.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { respondToStatementRefusal } from '@/lib/apiStatementExtraction';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { retryImport } from '@/modules/accounting/services/bank/bankStatementOcrService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);

  const { companyId } = req;
  const { id } = req.query as { id: string };

  try {
    return apiResponse.success(res, await retryImport(companyId, id));
  } catch (err) {
    if (respondToStatementRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
