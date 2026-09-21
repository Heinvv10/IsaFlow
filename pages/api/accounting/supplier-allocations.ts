/**
 * Supplier Payment Allocations API
 * GET  — List existing allocations (audit trail)
 * POST — Allocate payments against outstanding supplier invoices
 *
 * `payment_allocations` is the LIVE allocation table on the AP side. This route
 * used to read and write migration 201's `supplier_payment_allocations`, which
 * holds ZERO rows in dev and in production and is read by nothing:
 * `processSupplierPayment`, `voidSupplierPayment` and `batchPaymentService` all
 * use `payment_allocations`. Every allocation this route made was therefore
 * invisible to the balances that matter.
 *
 * The POST body is unchanged. What changed is that the writes, the guards and
 * the state machine now live in `supplierPaymentApplicationService`, shared
 * with `apply_payment_to_supplier_invoice` over MCP, and three defects went
 * with the move:
 *
 *   - it validated each invoice INSIDE the write loop and returned
 *     `badRequest` from within it. `withAuth` COMMITs on anything under 500, so
 *     a three-line request failing on line three committed lines one and two
 *     and reported failure. Every refusal now happens in the plan, before the
 *     first write.
 *   - it wrote `amount_paid` as an absolute value computed in JS from a figure
 *     read moments earlier — a lost update against a concurrent allocation.
 *   - it set a PROCESSED payment's status back to `'approved'` on a partial
 *     allocation, walking a payment whose journal had already posted backwards
 *     through its own state machine — and `voidSupplierPayment` accepts only
 *     `processed`, so that also quietly made it un-voidable.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import {
  applySupplierPaymentPlan,
  planSupplierPaymentApplication,
} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import {
  isRetryableSupplierPaymentRefusal,
  isSupplierPaymentRefusal,
} from '@/modules/accounting/services/ap/supplierPaymentRefusal';
import { isPaymentLockTimeout } from '@/modules/accounting/services/core/paymentLock';

interface AllocationItem {
  invoiceId: string;
  amount: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const paymentId = req.query.payment_id as string | undefined;
      const supplierId = req.query.supplier_id as string | undefined;

      let rows;
      if (paymentId) {
        rows = await sql`
          SELECT spa.id, spa.payment_id, spa.invoice_id, spa.amount_allocated AS amount,
            spa.created_at AS allocated_at, sp.payment_number, si.invoice_number,
            s.company_name AS supplier_name
          FROM payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
          JOIN supplier_invoices si ON si.id = spa.invoice_id
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE spa.payment_id = ${paymentId}
            AND sp.company_id = ${companyId}
          ORDER BY spa.created_at DESC
        `;
      } else if (supplierId) {
        rows = await sql`
          SELECT spa.id, spa.payment_id, spa.invoice_id, spa.amount_allocated AS amount,
            spa.created_at AS allocated_at, sp.payment_number, si.invoice_number,
            s.company_name AS supplier_name
          FROM payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
          JOIN supplier_invoices si ON si.id = spa.invoice_id
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.supplier_id = ${supplierId}
            AND sp.company_id = ${companyId}
          ORDER BY spa.created_at DESC
          LIMIT 200
        `;
      } else {
        rows = await sql`
          SELECT spa.id, spa.payment_id, spa.invoice_id, spa.amount_allocated AS amount,
            spa.created_at AS allocated_at, sp.payment_number, si.invoice_number,
            s.company_name AS supplier_name
          FROM payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
          JOIN supplier_invoices si ON si.id = spa.invoice_id
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.company_id = ${companyId}
          ORDER BY spa.created_at DESC
          LIMIT 200
        `;
      }

      return apiResponse.success(res, rows);
    } catch (err) {
      log.error('Failed to get supplier allocations', { err, companyId });
      return apiResponse.internalError(res, err as Error);
    }
  }

  if (req.method === 'POST') {
    const { paymentId, allocations } = req.body as {
      paymentId?: string;
      allocations?: AllocationItem[];
    };

    if (!paymentId) return apiResponse.badRequest(res, 'paymentId is required');
    if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
      return apiResponse.badRequest(res, 'allocations array is required');
    }

    // PLAN then APPLY. Only the plan may produce a 4xx: it takes the payment's
    // row lock, runs every guard and writes nothing, so a refusal here cannot
    // have committed anything.
    let plan;
    try {
      plan = await planSupplierPaymentApplication(companyId, paymentId, allocations);
    } catch (err) {
      // CONTENTION, not the caller's mistake, and answered 409 so a retry is
      // what the user is told to do. Two rows can raise it: the payment itself
      // (`PaymentLockTimeoutError`, the plan's first act) and a bill, which
      // `planSupplierAllocationLines` raises as a refusal carrying
      // `retryable: true`. Both are pre-write, so the 4xx `withAuth` COMMITs
      // commits nothing. The AR mirror is `customer-allocations.ts`.
      if (isPaymentLockTimeout(err) || isRetryableSupplierPaymentRefusal(err)) {
        log.info('Supplier allocation hit a contended row', { paymentId }, 'accounting');
        return apiResponse.conflict(res, (err as Error).message);
      }
      // Only a typed refusal may be answered with a 400. Catching everything
      // put a driver error's raw text (schema and column names included) in
      // front of the user on a status `withAuth` COMMITs, and monitored a
      // genuine fault as the user's mistake.
      if (!isSupplierPaymentRefusal(err)) {
        log.error('Supplier allocation failed', { paymentId, error: err }, 'accounting');
        throw err;
      }
      // `info`, not `error`: the user's own mistake, answered with the remedy.
      log.info('Supplier allocation refused', { paymentId, reason: err.message }, 'accounting');
      return apiResponse.badRequest(res, err.message);
    }

    // Nothing below is caught: a failure must reach withAuth as a 5xx so the
    // transaction rolls back rather than committing a partial apply.
    await applySupplierPaymentPlan(companyId, plan, user.id);

    log.info('Supplier allocations created', {
      paymentId,
      count: plan.lines.length,
      total: plan.allocatedAfter - plan.allocatedBefore,
    }, 'accounting');

    return apiResponse.success(res, {
      paymentId,
      allocations: plan.lines.map(l => ({
        invoiceId: l.invoiceId,
        amount: l.amount,
        newStatus: l.statusAfter,
      })),
      newAllocatedAmount: plan.allocatedAfter,
      paymentStatus: plan.paymentStatusAfter,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
