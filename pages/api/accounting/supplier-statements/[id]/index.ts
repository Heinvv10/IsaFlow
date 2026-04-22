/**
 * GET /api/accounting/supplier-statements/[id] — reconciliation detail
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { getReconciliation } from '@/modules/accounting/services/capture/supplierStatementReconService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'Missing id');

  const reconciliation = await getReconciliation(companyId, id);
  if (!reconciliation) return apiResponse.notFound(res, 'SupplierStatementReconciliation', id);

  return apiResponse.success(res, reconciliation);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
