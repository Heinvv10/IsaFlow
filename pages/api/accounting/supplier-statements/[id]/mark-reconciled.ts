/**
 * POST /api/accounting/supplier-statements/[id]/mark-reconciled
 *
 * Stamps the reconciliation as reconciled with the current user + timestamp.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { markReconciled, ReconciliationNotReadyError } from '@/modules/accounting/services/capture/supplierStatementReconService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const authed = req as CompanyAuthedRequest;
  const { companyId } = authed;
  const userId = authed.user?.id ?? '';
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'Missing id');

  try {
    await markReconciled(companyId, id, userId);
  } catch (err) {
    // Still being read, or failed to be: nothing was written, so 409 is safe.
    if (err instanceof ReconciliationNotReadyError) return apiResponse.conflict(res, err.message);
    throw err;
  }

  log.info('Reconciliation marked as reconciled', { reconciliationId: id }, 'supplier-stmt-api');

  return apiResponse.success(res, { id, status: 'reconciled' });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
