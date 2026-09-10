/**
 * Applying a supplier payment that is ALREADY in the ledger to the bills it
 * settles.
 *
 * THE SHAPE OF THE PROBLEM, from the AP side. `allocateTransaction` with
 * `allocType='supplier'` posts DR Accounts Payable / CR Bank and then calls
 * `fourWayMatchService#recordPaymentMatch`, which sets a `payment_matched`
 * BOOLEAN and never touches `amount_paid` or `status`. The GL says the bill is
 * paid, a flag says it is matched, and the subledger still shows it wholly
 * outstanding — which is how all seventeen supplier invoices could read as open
 * against a Sage book showing every one of them paid, with AP overstated by
 * R613,642.
 *
 * THAT NARRATIVE IS HISTORY FOR THE NO-INVOICE PATH. `allocateTransaction` no
 * longer guesses a bill: it creates the payment document and applies it only on
 * the supplier's `auto_allocate_strategy` (migration 614), through this very
 * service. `recordPaymentMatch` now runs only when the caller NAMED the bill.
 * This service is still what clears a payment that was left unapplied.
 *
 * So, like its AR twin, this posts NO JOURNAL. The cash has already left the
 * bank; posting again would double the payment. It moves the subledger into
 * agreement with the GL: allocation rows, `amount_paid`, status, and
 * `payment_matched`.
 *
 * PLAN AND APPLY ARE SEPARATE. `planSupplierPaymentApplication` takes the row
 * lock, runs every guard and writes nothing; `applySupplierPaymentPlan` writes
 * and guards nothing. A dry run is the first without the second.
 *
 * This replaces the inline SQL at `pages/api/accounting/supplier-allocations.ts`,
 * which carried the AR route's four defects plus two of its own:
 *   5. it wrote `supplier_payment_allocations` — a table with zero rows in dev
 *      and production that nothing reads — so its allocations were invisible to
 *      `processSupplierPayment` and to every balance downstream;
 *   6. it set a PROCESSED payment's status back to `'approved'` whenever the
 *      allocation was partial, walking a payment whose journal had already
 *      posted backwards through its own state machine.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockSupplierPaymentForUpdate } from '../core/paymentLock';
import {
  EPS,
  applyLineToBill,
  planSupplierAllocationLines,
  round2,
  type SupplierAllocationInput,
  type SupplierApplicationLine,
} from './supplierAllocationLines';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

export type { SupplierAllocationInput, SupplierApplicationLine };

/** Statuses whose payment journal has posted, so there is cash to apply. */
const POSTED_STATUSES = new Set(['processed', 'reconciled']);

export interface SupplierPaymentApplicationPlan {
  paymentId: string;
  paymentNumber: string;
  supplierId: string;
  paymentTotal: number;
  allocatedBefore: number;
  allocatedAfter: number;
  unappliedBefore: number;
  unappliedAfter: number;
  paymentStatusBefore: string;
  paymentStatusAfter: string;
  lines: SupplierApplicationLine[];
  /** Always false — the payment journal posted when the payment was processed. */
  postsJournal: false;
}

/**
 * Plan an application. Every refusal is a `SupplierPaymentRefusal`, and nothing
 * else is — `supplier-allocations.ts` and the MCP tool both classify on that
 * class, so a bare `Error` here would put a driver's raw text in front of the
 * user on a status `withAuth` COMMITs. A contended payment row leaves as
 * `PaymentLockTimeoutError` and a contended BILL as a retryable refusal; both
 * are raised before the first write.
 */
export async function planSupplierPaymentApplication(
  companyId: string,
  paymentId: string,
  allocations: readonly SupplierAllocationInput[],
): Promise<SupplierPaymentApplicationPlan> {
  if (allocations.length === 0) {
    throw new SupplierPaymentRefusal('Provide at least one allocation.');
  }

  const payment = await lockSupplierPaymentForUpdate(companyId, paymentId);
  if (!payment) throw new SupplierPaymentRefusal(`Supplier payment ${paymentId} not found`);

  const status = String(payment.status);
  if (status === 'cancelled') {
    throw new SupplierPaymentRefusal('Cannot apply a cancelled payment.');
  }
  if (!POSTED_STATUSES.has(status)) {
    throw new SupplierPaymentRefusal(
      `This payment has not been processed (status "${status}"), so no journal has posted for it `
      + 'and there is no cash to apply. Approve and process it first '
      + '(POST /api/accounting/supplier-payments-action), which posts DR Accounts Payable / '
      + 'CR Bank and applies its own allocations.',
    );
  }

  const supplierId = String(payment.supplier_id);
  const paymentTotal = Number(payment.total_amount);
  const allocatedBefore = Number(payment.allocated_amount ?? 0);
  const unappliedBefore = round2(paymentTotal - allocatedBefore);

  const requested = round2(allocations.reduce((s, a) => s + a.amount, 0));
  if (requested > unappliedBefore + EPS) {
    throw new SupplierPaymentRefusal(
      `Allocations total R${requested.toFixed(2)} but only R${unappliedBefore.toFixed(2)} of this `
      + `payment is unapplied (R${paymentTotal.toFixed(2)} paid, `
      + `R${allocatedBefore.toFixed(2)} already applied).`,
    );
  }

  const { lines } = await planSupplierAllocationLines(companyId, allocations, {
    paymentId,
    supplierId,
  });

  const allocatedAfter = round2(allocatedBefore + requested);
  const unappliedAfter = round2(paymentTotal - allocatedAfter);

  return {
    paymentId,
    paymentNumber: payment.payment_number ? String(payment.payment_number) : '',
    supplierId,
    paymentTotal,
    allocatedBefore,
    allocatedAfter,
    unappliedBefore,
    unappliedAfter,
    paymentStatusBefore: status,
    // A fully applied payment becomes `reconciled`; a partly applied one KEEPS
    // the status it has. The route this replaces set it to `'approved'`, which
    // moves a processed payment backwards — and `voidSupplierPayment` only
    // accepts `processed`, so that also quietly made it un-voidable.
    paymentStatusAfter: unappliedAfter <= EPS ? 'reconciled' : status,
    lines,
    postsJournal: false,
  };
}

/**
 * Perform a plan. Guards NOTHING — `planSupplierPaymentApplication` has run
 * them all under a lock this request still holds. Every statement is
 * company-scoped.
 */
export async function applySupplierPaymentPlan(
  companyId: string,
  plan: SupplierPaymentApplicationPlan,
  userId: string,
): Promise<SupplierPaymentApplicationPlan> {
  for (const line of plan.lines) {
    await sql`
      INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
      VALUES (${plan.paymentId}::UUID, ${line.invoiceId}::UUID, ${line.amount})
    `;
    await applyLineToBill(companyId, line);
  }

  await sql`
    UPDATE supplier_payments
    SET status = ${plan.paymentStatusAfter}, updated_at = NOW()
    WHERE id = ${plan.paymentId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Applied supplier payment to bills', {
    paymentId: plan.paymentId,
    lines: plan.lines.length,
    applied: round2(plan.allocatedAfter - plan.allocatedBefore),
    unappliedAfter: plan.unappliedAfter,
    userId,
  }, 'accounting');

  return plan;
}
