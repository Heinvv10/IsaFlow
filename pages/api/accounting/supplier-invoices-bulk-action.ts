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
import { itemFailureMessage, respondRowHeld } from '@/lib/apiDocumentLock';
import { isHeldRowError } from '@/lib/lockTimeout';
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
import { sql, withSavepoint } from '@/lib/neon';
import { UUID } from '@/lib/schemas/common';
import {
  approveSupplierInvoice,
  cancelSupplierInvoice,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { BankControlError } from '@/modules/accounting/services/bank/bankControlRefusal';
import type { LateClaimInfo } from '@/modules/accounting/services/gl/vatLateClaimPlan';
import { ImpersonationForbiddenError } from '@/lib/auth/impersonationGuard';
import { ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';

const Schema = z.object({
  action: z.enum(['approve', 'cancel', 'post_gl']),
  invoiceIds: z.array(UUID).min(1).max(200),
});

const NOTHING: { lateClaim?: LateClaimInfo; warnings?: string[] } = {};

interface ItemResult {
  invoiceId: string;
  /** The bill's number, so a screen can name it; null when the id is not one of this company's bills. */
  invoiceNumber: string | null;
  ok: boolean;
  error?: string;
  /** R-035: why the approval gate refused this bill (APPROVAL_REQUIRED / _PENDING / _STALE). */
  reason?: string;
  /** Set when the bill's input VAT was claimed late (s16(3)) — gl/vatLateClaimPlan. */
  lateClaim?: LateClaimInfo;
  warnings?: string[];
}

/**
 * The numbers the results are named by — this company's bills only. Naming is
 * cosmetic, so a failure must not stop the action: it runs in its OWN savepoint
 * (a caught SQL error still poisons the transaction otherwise), is logged, and
 * leaves the results unnamed (null), which the screen words by count.
 */
async function billNumbers(companyId: string, ids: string[]): Promise<Map<string, string | null>> {
  try {
    const rows = await withSavepoint('bulk_supplier_invoice_numbers', async () => (await sql`
      SELECT id::TEXT AS id, invoice_number FROM supplier_invoices
      WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
    `) as Array<{ id: string; invoice_number: string | null }>);
    return new Map(rows.map((r) => [r.id, r.invoice_number]));
  } catch (err) {
    log.warn('Bulk supplier invoice numbers not read; results go unnamed', { error: err }, 'accounting-api');
    return new Map();
  }
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

  const { action, invoiceIds } = parsed.data;
  const userId = req.user.id;
  const results: ItemResult[] = [];
  let held = 0;

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

  const numberOf = await billNumbers(companyId, ordered);

  for (const invoiceId of ordered) {
    try {
      // A person's bulk APPROVE opts in to the s16(3) late claim. Post to GL does
      // not: its bill was already approved, so already in the filed figures.
      // `warnings`: a cost-centre pick the posting dropped (gl/dimensions/costCentrePick).
      const { lateClaim, warnings } = await withSavepoint('bulk_supplier_invoice_item', async () => {
        switch (action) {
          case 'approve':
            return approveSupplierInvoice(companyId, invoiceId, userId, { allowLateInputClaim: true });
          case 'cancel':
            await cancelSupplierInvoice(companyId, invoiceId, userId);
            return NOTHING;
          case 'post_gl':
            return { ...NOTHING, warnings: (await postSupplierInvoiceToGL(companyId, invoiceId, userId)).warnings };
        }
        return NOTHING;
      });
      results.push({ invoiceId, invoiceNumber: numberOf.get(invoiceId) ?? null, ok: true, ...(lateClaim ? { lateClaim } : {}), ...(warnings ? { warnings } : {}) });
    } catch (err) {
      // R-032 L5: the session, not this id, is refused — every id would be. Answer 403.
      if (err instanceof ImpersonationForbiddenError) throw err;
      const message = itemFailureMessage(err, 'Action failed');
      log.warn('Bulk supplier invoice action failed for one id', {
        action, invoiceId, error: message,
      }, 'accounting-api');
      if (isHeldRowError(err)) held += 1;
      results.push({ invoiceId, invoiceNumber: numberOf.get(invoiceId) ?? null, ok: false, error: message, ...(err instanceof ApprovalRequiredError ? { reason: err.reason } : {}),
        ...(err instanceof BankControlError ? { reason: err.code } : {}) }); // step 2: e.g. IMPORTER_MAY_NOT_ALLOCATE

      // The savepoint's own ROLLBACK TO failed, so the connection is genuinely
      // aborted and nothing this request wrote can commit. Reporting the rows
      // that "succeeded" before it would be a lie the caller cannot detect —
      // withAuth's COMMIT is executed as ROLLBACK and still returns 200. Fail
      // the whole request instead so withErrorHandler answers 5xx.
      if (als.getStore()?.txUnusable) {
        throw new Error(
          `Bulk ${action} aborted: the transaction became unusable at ${invoiceId} `
          + `(${message}). No row in this batch was saved.`,
        );
      }
    }
  }

  // D11: every id a held row means nothing was committed: 503 + Retry-After. Mixed results keep the 200 per-item answer.
  if (held > 0 && held === results.length) {
    return respondRowHeld(res, 'These invoices are being processed by another request — retry in a moment.', 'ROW_LOCK_TIMEOUT');
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
