/**
 * Supplier Invoice Bulk Actions API
 * POST /api/accounting/supplier-invoices-bulk-action
 *   { action: 'approve' | 'cancel' | 'post_gl', invoiceIds: UUID[] }
 *
 * Runs each per-id action sequentially and reports outcome per id.
 *
 * The whole request — every id in the batch — runs in ONE transaction on the
 * ALS-bound client (withAuth, PR #264); the workflow services open none of
 * their own. So the per-id try/catch alone does not isolate anything: an error
 * that aborts the transaction (a 55P03 lock timeout, most of all, now that
 * every action here takes a row lock) leaves every sibling failing 25P02, and
 * withAuth's COMMIT on a <500 response is executed by PostgreSQL as ROLLBACK
 * without raising — reporting `succeeded: N` for writes that no longer exist.
 * Each id is therefore wrapped in its own SAVEPOINT: a failed row rolls back to
 * it, the transaction stays usable, and successful sibling rows survive.
 *
 * Replaces the previous client-side fan-out (N parallel POSTs to
 * supplier-invoices-action) which had no atomicity story and provided no
 * per-id failure reporting.
 */

import { z } from 'zod';
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
  withWriteAccess,
} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { als } from '@/lib/als';
import { withSavepoint } from '@/lib/neon';
import { UUID } from '@/lib/schemas/common';
import {
  approveSupplierInvoice,
  cancelSupplierInvoice,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';

const Schema = z.object({
  action: z.enum(['approve', 'cancel', 'post_gl']),
  invoiceIds: z.array(UUID).min(1).max(200),
  approvalIds: z.record(UUID, UUID).optional(),
});

interface ItemResult {
  invoiceId: string;
  ok: boolean;
  error?: string;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const parsed = Schema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.validationError(
      res,
      parsed.error.flatten().fieldErrors as Record<string, string[]>,
    );
  }

  const { action, invoiceIds, approvalIds } = parsed.data;
  const userId = req.user.id;
  const results: ItemResult[] = [];

  // Sorted, NOT the order the client sent. Every action below now takes a row
  // lock (approve via lockSupplierInvoiceForUpdate, cancel via its own
  // FOR UPDATE) and holds it to the end of this request's single transaction.
  // Two overlapping batches that walk the same rows in opposite orders deadlock
  // on each other (40P01) — this route with the grid's selection order, and
  // `bulk_approve_supplier_invoices`, which sorts for exactly this reason. A
  // total order over the locked rows makes that impossible: the batch that gets
  // there first simply blocks the other. Sorting also cannot change the outcome,
  // since each id is processed independently and reported by id.
  const ordered = [...invoiceIds].sort();

  for (const invoiceId of ordered) {
    try {
      await withSavepoint('bulk_supplier_invoice_item', async () => {
        switch (action) {
          case 'approve':
            await approveSupplierInvoice(companyId, invoiceId, userId, { approvalId: approvalIds?.[invoiceId] });
            break;
          case 'cancel':
            await cancelSupplierInvoice(companyId, invoiceId, userId, { approvalId: approvalIds?.[invoiceId] });
            break;
          case 'post_gl':
            await postSupplierInvoiceToGL(companyId, invoiceId, userId, { approvalId: approvalIds?.[invoiceId] });
            break;
        }
      });
      results.push({ invoiceId, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed';
      log.warn('Bulk supplier invoice action failed for one id', {
        action, invoiceId, error: message,
      }, 'accounting-api');
      results.push({ invoiceId, ok: false, error: message });

      // The savepoint's own ROLLBACK TO failed, so the connection is genuinely
      // aborted and nothing this request wrote can commit. Reporting the rows
      // that "succeeded" before it would be a lie the caller cannot detect —
      // withAuth's COMMIT is executed as ROLLBACK and still returns 200. Fail
      // the whole request instead so withErrorHandler answers 5xx.
      if (als.getStore()?.txUnusable || als.getStore()?.controlWriteFailed) {
        throw new Error(
          `Bulk ${action} aborted: the transaction became unusable at ${invoiceId} `
          + `(${message}). No row in this batch was saved.`,
        );
      }
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  return apiResponse.success(res, {
    action,
    total: results.length,
    succeeded,
    failed,
    results,
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
