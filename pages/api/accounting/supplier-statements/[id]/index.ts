/**
 * GET    /api/accounting/supplier-statements/[id] — reconciliation detail. While the statement is being
 *        read its status is 'extracting' (with page progress); a failed read is 'failed' with
 *        extractionError and retryable.
 * DELETE /api/accounting/supplier-statements/[id] — removes a reconciliation that failed to be read.
 *        409 for any other.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { apiResponse } from '@/lib/apiResponse';
import { respondToStatementRefusal } from '@/lib/apiStatementExtraction';
import { getReconciliation } from '@/modules/accounting/services/capture/supplierStatementReconService';
import { deleteFailedReconciliation } from '@/modules/accounting/services/capture/supplierStatementLifecycle';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'DELETE']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'Missing id');

  if (req.method === 'DELETE') {
    try {
      await deleteFailedReconciliation(companyId, id);
      return apiResponse.success(res, { deleted: true });
    } catch (err) {
      if (respondToStatementRefusal(res, err)) return;
      throw err;
    }
  }

  const reconciliation = await getReconciliation(companyId, id);
  if (!reconciliation) return apiResponse.notFound(res, 'SupplierStatementReconciliation', id);

  return apiResponse.success(res, reconciliation);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
