/**
 * Supplier Batch Payments API
 * GET  — list batches
 * POST — create batch
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { getBatches, getBatchById, createBatch } from '@/modules/accounting/services/ap/batchPaymentService';
import { SupplierNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { countBatchBills, getBatchMembers } from '@/modules/accounting/services/ap/batchPaymentMembers';
import { pendingReservations } from '@/modules/accounting/services/ap/supplierBatchAllocationPlan';
import { describeApprovalGate } from '@/modules/accounting/services/gl/approvalGate';
import { batchChangedSinceApproval, currentBatchDigest } from '@/modules/accounting/services/ap/batchApprovedDigest';
import {
  isRetryableSupplierPaymentRefusal,
  isSupplierPaymentRefusal,
} from '@/modules/accounting/services/ap/supplierPaymentRefusal';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const { id, status, limit, offset, reservedFor } = req.query;

    // What unprocessed payments already reserve on these bills — the SAME
    // pending set batch creation subtracts — so the new-batch page offers only
    // an amount the server will accept.
    // Ids are checked with the repo's `UUID` (z.guid — it accepts the seeded
    // version-0 ids z.uuid() rejects) and refused 400 whole, before any query:
    // a bad one used to reach the ::UUID cast and answer 500 with pg's text.
    if (typeof reservedFor === 'string') {
      const ids = reservedFor.split(',').filter((v) => v !== '');
      if (ids.length > 500 || ids.some((v) => !UUID.safeParse(v).success)) {
        return apiResponse.badRequest(res, 'reservedFor must be a comma-separated list of up to 500 bill ids.');
      }
      return apiResponse.success(res, Object.fromEntries(await pendingReservations(companyId, ids)));
    }

    // Single batch by ID
    if (id) {
      if (!UUID.safeParse(id).success) return apiResponse.badRequest(res, 'id must be a batch id.');
      const batch = await getBatchById(companyId, id as string);
      if (!batch) return apiResponse.notFound(res, 'Batch', id as string);
      // Read BEFORE the payments below: an approve sends it back as what the approver saw (migration 922), so a change
      // between the two reads makes the approve refuse, never vouch for payments the page did not show.
      const contentDigest = await currentBatchDigest(companyId, batch.id);
      return apiResponse.success(res, {
        ...batch,
        contentDigest,
        payments: await getBatchMembers(companyId, batch.id),
        billCount: await countBatchBills(companyId, batch.id),
        // R-035 PR5: the derived approval state while approve or process is still ahead.
        approval: batch.status === 'draft' || batch.status === 'approved'
          ? await describeApprovalGate(companyId, 'payment_batch', batch.id) : null,
        // Migration 922: approved, but its content is no longer what was approved — file, send and process refuse it.
        changedSinceApproval: batch.status === 'approved' || batch.status === 'processed'
          ? await batchChangedSinceApproval(companyId, batch.id) : false,
      });
    }

    const result = await getBatches(companyId, {
      status: status as string,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return apiResponse.success(res, result);
  }

  if (req.method === 'POST') {
    const userId = req.user.id;  // User identity from JWT only
    try {
      const item = await createBatch(companyId, req.body, userId);
      return apiResponse.success(res, item);
    } catch (err) {
      // R-068: refused before the batch row is written; surface the typed message.
      if (err instanceof SupplierNotInCompanyError) return apiResponse.badRequest(res, err.message);
      // K-064: every bill line is checked before the first write, so both
      // answers COMMIT nothing. Contention on a bill is a retry, not a mistake: a held bill is 503 + Retry-After
      // (D11); a retryable state conflict stays 409.
      if (respondIfLockTimeout(res, err)) return;
      if (isRetryableSupplierPaymentRefusal(err)) return apiResponse.conflict(res, (err as Error).message);
      if (isSupplierPaymentRefusal(err)) return apiResponse.badRequest(res, err.message);
      log.error('Batch payment create failed', { error: err }, 'accounting-api');
      return apiResponse.badRequestFromError(res, err, 'Create failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
