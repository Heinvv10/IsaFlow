/**
 * POST /api/accounting/supplier-statements/[id]/rematch
 *
 * Recomputes matches without re-running the VLM.
 * Useful when supplier_invoices change after the initial import.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { rematchLines } from '@/modules/accounting/services/capture/supplierStatementReconService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (!id) return apiResponse.badRequest(res, 'Missing id');

  log.info('Rematch requested', { reconciliationId: id }, 'supplier-stmt-api');

  const reconciliation = await rematchLines(companyId, id);
  return apiResponse.success(res, reconciliation);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
