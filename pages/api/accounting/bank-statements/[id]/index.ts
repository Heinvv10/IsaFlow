/**
 * GET    /api/accounting/bank-statements/[id] — one bank_statement_imports record, with rows + warnings.
 *        While it is being read its status is 'extracting' (with page progress); a failed read is
 *        'failed' with extractionError and retryable.
 * DELETE /api/accounting/bank-statements/[id] — removes an import that failed to be read. 409 for any other.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { respondToStatementRefusal } from '@/lib/apiStatementExtraction';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { deleteFailedImport, getImport } from '@/modules/accounting/services/bank/bankStatementOcrService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const { id } = req.query as { id: string };

  if (req.method === 'DELETE') {
    try {
      await deleteFailedImport(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      if (respondToStatementRefusal(res, err)) return;
      throw err;
    }
  }

  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'DELETE']);

  const imp = await getImport(companyId, id);
  if (!imp) return apiResponse.notFound(res, 'Bank statement import not found');

  return apiResponse.success(res, imp);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
