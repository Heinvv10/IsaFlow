/**
 * POST /api/accounting/supplier-statements/[id]/retry
 *
 * Reads a failed (or interrupted) supplier statement again, in the background. Answers with the
 * reconciliation, 'extracting'. 409 if it is not failed, is still being read, or has too many pages.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { apiResponse } from '@/lib/apiResponse';
import { respondToStatementRefusal } from '@/lib/apiStatementExtraction';
import { retryReconciliation } from '@/modules/accounting/services/capture/supplierStatementLifecycle';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'Missing id');

  try {
    return apiResponse.success(res, await retryReconciliation(companyId, id));
  } catch (err) {
    if (respondToStatementRefusal(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
