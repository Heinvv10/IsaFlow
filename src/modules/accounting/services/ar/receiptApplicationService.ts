import {applyLegacyCashPlan,type CashApplicationApprovalOptions} from '../shared/cashApplicationLegacyAdapter';
/**
 * Applying a customer receipt that is ALREADY in the ledger to the invoices it
 * settles.
 *
 * THE SHAPE OF THE PROBLEM. `bankAllocationService#allocateTransaction` with
 * `allocType='customer'` posts DR Bank / CR Accounts Receivable and inserts a
 * `customer_payments` row already at status `confirmed` — and writes no
 * `customer_payment_allocations` and never touches
 * `customer_invoices.amount_paid`. The cash is on the control account and no
 * document knows about it. That is the R2.45m of unapplied receipts, and it is
 * why aged debtors reads as a list of everything ever invoiced.
 *
 * So this service posts NO JOURNAL. The cash is already in the ledger; posting
 * again would double the bank. What it does is move the SUBLEDGER into
 * agreement with the GL: allocation rows, `amount_paid`, invoice status.
 *
 * PLAN AND APPLY ARE SEPARATE ON PURPOSE. `planReceiptApplication` takes the
 * row lock, runs every guard and writes nothing; `applyReceiptPlan` writes and
 * guards nothing. A dry run is the first without the second, so it is
 * structurally incapable of passing where the live call would refuse — the
 * failure `docs/mcp/CONTRACTS.md` §6 calls worse than no dry run at all. It
 * also lets an MCP handler answer every refusal with `toolError` BEFORE the
 * first write, which the idempotency contract requires.
 *
 * This replaces the inline SQL at `pages/api/accounting/customer-allocations.ts`,
 * which carried four defects this does not:
 *   1. it compared `invoice.client_id !== payment.client_id`, so an invoice
 *      populated on `customer_id` alone could never be allocated at all;
 *   2. it wrote `amount_paid` as an absolute value computed in JS from a figure
 *      read moments earlier — a lost update under concurrency;
 *   3. it returned `badRequest` from inside its per-invoice loop, and `withAuth`
 *      COMMITs on anything under 500, so a three-line request failing on line
 *      three committed lines one and two and reported failure;
 *   4. it took no row lock, so two applications of one receipt both passed the
 *      remainder check.
 */

import { lockCustomerPaymentForUpdate } from '../core/paymentLock';
import {
  EPS,
  planAllocationLines,
  round2,
  type ReceiptAllocationInput,
  type ReceiptApplicationLine,
} from './receiptAllocationLines';

export type { ReceiptAllocationInput, ReceiptApplicationLine };

export interface ReceiptApplicationPlan {
  paymentId: string;
  paymentNumber: string;
  customerId: string;
  paymentTotal: number;
  allocatedBefore: number;
  allocatedAfter: number;
  unappliedBefore: number;
  unappliedAfter: number;
  paymentStatusBefore: string;
  paymentStatusAfter: string;
  lines: ReceiptApplicationLine[];
  /**
   * Always false. Stated rather than implied because a caller has to be able to
   * tell an agent that no journal posts here — an agent that assumed one had
   * would go looking for it, or worse, post one.
   */
  postsJournal: false;
}

/**
 * Validate a proposed application and return exactly what it would do.
 *
 * Takes a `FOR UPDATE` lock on the payment and holds it for the rest of the
 * request, so the plan cannot go stale between here and `applyReceiptPlan`.
 * Throws on any refusal — every one of them before a single write.
 */
export async function planReceiptApplication(
  companyId: string,
  paymentId: string,
  allocations: readonly ReceiptAllocationInput[],
): Promise<ReceiptApplicationPlan> {
  if (allocations.length === 0) throw new Error('Provide at least one allocation.');

  const payment = await lockCustomerPaymentForUpdate(companyId, paymentId);
  if (!payment) throw new Error(`Customer payment ${paymentId} not found`);

  const status = String(payment.status);
  if (status === 'cancelled') {
    throw new Error('Cannot apply a cancelled payment.');
  }
  if (status === 'draft') {
    throw new Error(
      'This receipt is still a draft — no journal has posted for it, so there is no cash to '
      + 'apply. Confirm the payment first (POST /api/accounting/customer-payments-action), '
      + 'which posts DR Bank / CR Accounts Receivable and applies its own allocations.',
    );
  }

  const customerId = String(payment.client_id);
  const paymentTotal = Number(payment.total_amount);
  const allocatedBefore = Number(payment.allocated_amount ?? 0);
  const unappliedBefore = round2(paymentTotal - allocatedBefore);

  const requested = round2(allocations.reduce((s, a) => s + a.amount, 0));
  if (requested > unappliedBefore + EPS) {
    throw new Error(
      `Allocations total R${requested.toFixed(2)} but only R${unappliedBefore.toFixed(2)} of this `
      + `receipt is unapplied (R${paymentTotal.toFixed(2)} received, `
      + `R${allocatedBefore.toFixed(2)} already applied).`,
    );
  }

  const { lines } = await planAllocationLines(companyId, allocations, { paymentId, customerId });

  const allocatedAfter = round2(allocatedBefore + requested);
  const unappliedAfter = round2(paymentTotal - allocatedAfter);

  return {
    paymentId,
    paymentNumber: payment.payment_number ? String(payment.payment_number) : '',
    customerId,
    paymentTotal,
    allocatedBefore,
    allocatedAfter,
    unappliedBefore,
    unappliedAfter,
    paymentStatusBefore: status,
    // Preserves the existing route's state machine: a fully applied receipt
    // becomes `reconciled`. Worth knowing before relying on it —
    // `cancelCustomerPayment` requires status `confirmed`, so a fully applied
    // receipt can no longer be cancelled. That asymmetry predates this service
    // and is deliberately not changed here.
    paymentStatusAfter: unappliedAfter <= EPS ? 'reconciled' : 'confirmed',
    lines,
    postsJournal: false,
  };
}

/** Execute only the exact stored plan through the shared application control. */
export async function applyReceiptPlan(
  companyId: string,
  plan: ReceiptApplicationPlan,
  userId: string,
  options?: CashApplicationApprovalOptions,
): Promise<ReceiptApplicationPlan> {
  await applyLegacyCashPlan(companyId,userId,'customer',plan,options);
  return plan;
}
