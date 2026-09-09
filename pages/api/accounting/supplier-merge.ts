/**
 * Supplier Merge API
 * POST /api/accounting/supplier-merge
 *
 * Merges financially unreferenced contacts in one authenticated transaction.
 * Payment, approval and beneficiary dependencies require review first.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { mergeControlledSuppliers, SupplierMergeControlError } from '@/modules/accounting/services/core/supplierMergeControl';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';

const MergeBodySchema = z.object({
  source_id: UUID,
  target_id: UUID,
}).strict().refine(v => v.source_id !== v.target_id, {
  message: 'source_id and target_id must be different suppliers',
  path: ['target_id'],
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const parsed = MergeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { source_id, target_id } = parsed.data;

  try {
    await mergeControlledSuppliers(companyId, target_id, source_id);

    log.info('Supplier merge completed', {
      source_id,
      target_id,
      companyId,
      module: 'accounting',
    });

    return apiResponse.success(res, { merged: true, target_id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('supplier-merge POST failed', { error: message, module: 'accounting' });

    if (err instanceof SupplierMergeControlError || message.includes('not found or do not belong')) {
      return apiResponse.badRequest(res, message);
    }
    return apiResponse.internalError(res, err, 'Failed to merge suppliers');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
