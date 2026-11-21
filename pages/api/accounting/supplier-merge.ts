/**
 * Supplier Merge API
 * POST /api/accounting/supplier-merge
 *
 * Re-parents the source's payments, bills, purchase orders, credit notes, intercompany side and open expectations onto
 * target_id within a single transaction, then soft-deletes the source and records its survivor (merged_into_id, #1655).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withTransaction } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { withErrorHandler } from '@/lib/api-error-handler';
import { log } from '@/lib/logger';
import {
  SupplierMergeRefusal, assertSupplierMergeKeepsDrcFlag, assertSupplierMergeMovesNoNotedBill, refuseIfMovedNotedBills,
} from '@/modules/accounting/services/core/duplicateMergeService';
import { lockMovablePurchaseOrders, movePurchaseOrders } from '@/modules/accounting/services/core/supplierMergePurchaseOrders';
import { moveExpectationsAndAlerts, moveIntercompanySide, sideRefusal } from '@/modules/accounting/services/core/supplierMergeOpenWork';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { lockBatchesPayingSupplier, stampBatchesOfMovedPayments } from '@/modules/accounting/services/ap/supplierPaymentAuthors';

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

  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  const parsed = MergeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }
  const { source_id, target_id } = parsed.data;

  try {
    // Before the transaction: a refusal moves nothing.
    await assertSupplierMergeKeepsDrcFlag(companyId, source_id, target_id, source_id);
    // A bill tied to a PO only by its goods received note is refused as a PO link is (#1708).
    await assertSupplierMergeMovesNoNotedBill(companyId, source_id);
    await withTransaction(async (tx) => {
      // 1. Validate both suppliers belong to this company and are active
      const suppliers = await tx`
        SELECT id, name
        FROM suppliers
        WHERE id IN (${source_id}, ${target_id})
          AND company_id = ${companyId}
          AND deleted_at IS NULL
      `;

      if ((suppliers as { id: string; name: string }[]).length !== 2) {
        throw new Error('One or both suppliers not found or do not belong to this company');
      }

      // The source's purchase orders locked first, then the PO <-> bill link and approved-PO refusals (lockMovablePurchaseOrders).
      const pos = await lockMovablePurchaseOrders(companyId, source_id, companyRole);
      const sideBlock = await sideRefusal(companyId, source_id, target_id);
      if (sideBlock) throw new SupplierMergeRefusal(sideBlock);
      const side = await moveIntercompanySide(companyId, source_id, target_id);
      if (side.refusal) throw new SupplierMergeRefusal(side.refusal);

      // 2. Re-parent supplier_payments. supplier_id is approval content too —
      // with it the payee's bank details (R-035 PR5): the merging user becomes
      // an author of every payment it moves, and of each batch they belong to.
      // Their batches are locked first: batch before members, the order
      // approveBatch / processBatch take (bank/.claude.md lock order).
      const batchIds = await lockBatchesPayingSupplier(companyId, source_id, null);
      await tx`
        UPDATE supplier_payments
        SET supplier_id = ${target_id},
            content_authors = approval_add_author(content_authors, ${user.id}::UUID), content_edited_at = NOW()
        WHERE supplier_id = ${source_id}
          AND company_id = ${companyId}
      `;
      await stampBatchesOfMovedPayments(companyId, batchIds, user.id);

      // 3. Re-parent supplier_invoices — AFTER the payments, as every payment
      // writer takes a payment and then its bills (bank/.claude.md lock order;
      // bills first deadlocked a concurrent process, 2026-10-24). supplier_id is
      // approval content (R-035): the merging user becomes an author of every
      // bill it moves.
      const movedBills = await tx`
        UPDATE supplier_invoices
        SET supplier_id = ${target_id},
            content_authors = approval_add_author(content_authors, ${user.id}::UUID), content_edited_at = NOW()
        WHERE supplier_id = ${source_id}
          AND company_id = ${companyId}
        RETURNING invoice_number, grn_id, deleted_at, status
      `;
      // A bill made live and noted while this ran, without the supplier lock, is moved here after it waited on the row (#1708):
      // refused, and this transaction's savepoint takes the whole merge back.
      refuseIfMovedNotedBills(movedBills as Array<Record<string, unknown>>);

      // 4. Re-parent supplier_purchase_orders
      await tx`
        UPDATE supplier_purchase_orders
        SET supplier_id = ${target_id}
        WHERE supplier_id = ${source_id}
          AND company_id = ${companyId}
      `;

      // 5. Re-parent purchase_orders (the canonical PO table, mig 246b) under updatePurchaseOrder's supplier-change controls
      // (an audit row per PO; supplierMergePurchaseOrders), and supplier credit notes (credit_notes, mig 202: one table for both
      // customer and supplier notes; supplier_id is approval content, as on a bill). Then the intercompany side and the open
      // expectations / alerts. The supplier_id tables that stay behind, and why: the comment in supplierMergeOpenWork.
      await movePurchaseOrders(companyId, pos, source_id, target_id, { userId: user.id, role: companyRole, via: 'supplier-merge' });
      await tx`
        UPDATE credit_notes
        SET supplier_id = ${target_id},
            content_authors = approval_add_author(content_authors, ${user.id}::UUID), content_edited_at = NOW()
        WHERE supplier_id = ${source_id}
          AND company_id = ${companyId}
      `;
      await moveExpectationsAndAlerts(companyId, source_id, target_id, { userId: user.id, via: 'supplier-merge' });

      // 6. Soft-delete the source supplier, recording its survivor (merged_into_id, migration 1020):
      // the Sage import follows a merged-away supplier to it, so a re-sync's bills land on the
      // survivor, not back on the source (#1655). Neither the name nor is_active is touched, as in duplicates-merge
      // and a plain soft delete: a merged-away row is told by merged_into_id (and deleted_at hides it), and
      // restoreRow undoes only deleted_at and merged_into_id. (The old ' [MERGED]' rename could overflow
      // suppliers.name VARCHAR(255) on a long name and roll the merge back.)
      await tx`
        UPDATE suppliers
        SET deleted_at = NOW(),
            merged_into_id = ${target_id}
        -- A bill create racing this merge waits on the supplier row (the FK), then is refused by trg_supplier_invoices_supplier_live
        -- (migration 1021): no bill lands on the merged-away source.
        WHERE id = ${source_id}
          AND company_id = ${companyId}
      `;
    });

    log.info('Supplier merge completed', {
      source_id,
      target_id,
      companyId,
      module: 'accounting',
    });

    return apiResponse.success(res, { merged: true, target_id });
  } catch (err: unknown) {
    // A held row or a deadlock victim: 503 + Retry-After (the supplier lock helper's own timeout included).
    if (respondIfLockTimeout(res, err)) return;
    const message = err instanceof Error ? err.message : String(err);
    log.error('supplier-merge POST failed', { error: message, module: 'accounting' });

    if (err instanceof SupplierMergeRefusal || message.includes('not found or do not belong')) {
      return apiResponse.badRequest(res, message);
    }
    return apiResponse.internalError(res, err, 'Failed to merge suppliers');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as never))));
