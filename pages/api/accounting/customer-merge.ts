/**
 * Customer Merge API
 * POST /api/accounting/customer-merge
 *
 * Moves everything that belongs to source_id onto target_id in one
 * transaction, then soft-deletes the source. The rules live in
 * customerMergeService (K-061); this route only validates the ids and maps a
 * refusal to 400.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';
import { ArRequestError } from '@/modules/accounting/services/ar/arErrors';
import { mergeCustomers } from '@/modules/accounting/services/ar/customerMergeService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { source_id, target_id } = (req.body ?? {}) as Record<string, unknown>;

  if (!isUuidParam(source_id) || !isUuidParam(target_id)) {
    return apiResponse.badRequest(res, 'source_id and target_id must be customer ids');
  }

  try {
    const result = await mergeCustomers(companyId, source_id, target_id);
    log.info('Customer merge completed', { source_id, companyId, ...result, module: 'accounting' });
    return apiResponse.success(res, result);
  } catch (err: unknown) {
    if (err instanceof ArRequestError) {
      return apiResponse.badRequest(res, err.message);
    }
    log.error('customer-merge POST failed', {
      error: err instanceof Error ? err.message : String(err), module: 'accounting',
    });
    return apiResponse.internalError(res, err, 'Failed to merge customers');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
