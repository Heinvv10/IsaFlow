/**
 * Take a processed supplier payment's cash back off one bill (or all of them)
 * WITHOUT voiding the payment.
 *
 * A wrong oldest-first application could only be undone by voiding — which
 * reverses the payment journal and cancels the document — and then re-creating
 * the cash. The cash is right; only its application is wrong. So this moves the
 * SUBLEDGER only: the bill's amount_paid comes back down, the allocation row
 * goes, and the payment keeps its DR Accounts Payable / CR Bank journal with a
 * larger unapplied remainder — the population list_unapplied_payments and
 * reconcile_subledger already explain, and apply_payment_to_supplier_invoice
 * already clears.
 *
 * The bill's status, paid_at and payment_matched are set by
 * `recomputeInvoiceStatus`, the guarded single writer — never inline here.
 *
 * Every refusal is decided by `buildPlan` from reads; the live path plans on
 * rows it holds (payment first, then bills by id — the order void takes).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockSupplierPaymentForUpdate } from '../core/paymentLock';
import { withSupplierInvoiceLock } from './supplierInvoiceLock';
import { FIFO_ELIGIBLE_STATUSES, recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { UnapplyRefusal } from '../shared/unapplyRefusal';

export { UnapplyRefusal };

export interface PaymentUnapplyInput {
  paymentId: string;
  /** Only this bill. Omitted: every bill the payment is applied to. */
  invoiceId?: string;
}

export interface UnapplyLine {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  outstandingBefore: number;
  outstandingAfter: number;
}

export interface PaymentUnapplyResult {
  paymentId: string;
  paymentNumber: string;
  amountUnapplied: number;
  lines: UnapplyLine[];
  paymentStatusAfter: string;
  unappliedAfter: number;
}

const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function planSupplierPaymentUnapply(
  companyId: string,
  input: PaymentUnapplyInput,
): Promise<PaymentUnapplyResult> {
  return buildPlan(companyId, input);
}

export async function unapplySupplierPayment(
  companyId: string,
  input: PaymentUnapplyInput,
  userId: string,
): Promise<PaymentUnapplyResult> {
  // Payment first, then its bills by id: the order void and process take.
  await lockSupplierPaymentForUpdate(companyId, input.paymentId);
  // BOUNDED: lockSupplierPaymentForUpdate restores the default lock_timeout on
  // its way out, and there is no session default, so a bare FOR UPDATE here
  // would wait forever on a contended bill. The shared helper bounds it and
  // raises SUPPLIER_INVOICE_LOCK_TIMEOUT, which reaches the agent as "retry".
  await withSupplierInvoiceLock('unapplySupplierPayment', `payment ${input.paymentId}`, () => sql`
    SELECT si.id FROM supplier_invoices si
    JOIN payment_allocations pa ON pa.invoice_id = si.id
    WHERE pa.payment_id = ${input.paymentId}::UUID AND si.company_id = ${companyId}::UUID
      AND si.deleted_at IS NULL
      AND (${input.invoiceId ?? null}::UUID IS NULL OR si.id = ${input.invoiceId ?? null}::UUID)
    ORDER BY si.id
    FOR UPDATE OF si`);
  const plan = await buildPlan(companyId, input);

  for (const line of plan.lines) {
    const done = (await sql`
      UPDATE supplier_invoices
      SET amount_paid = amount_paid - ${line.amount}, updated_at = NOW()
      WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
        AND amount_paid >= ${line.amount}
      RETURNING id`) as DbRow[];
    // The plan read amount_paid >= amount under the same lock; a miss here is a
    // defect, not the caller's problem — thrown, so the registry unwinds.
    if (done.length === 0) {
      throw new Error(`unapplySupplierPayment: bill ${line.invoiceId} holds less than the ${line.amount} planned`);
    }
    await recomputeInvoiceStatus(companyId, 'supplier', line.invoiceId);
    await sql`
      DELETE FROM payment_allocations
      WHERE payment_id = ${plan.paymentId}::UUID AND invoice_id = ${line.invoiceId}::UUID`;
  }
  // 'reconciled' on a supplier payment means FULLY APPLIED; with a remainder
  // it is 'processed' again.
  await sql`
    UPDATE supplier_payments SET status = ${plan.paymentStatusAfter}
    WHERE id = ${plan.paymentId}::UUID AND company_id = ${companyId}::UUID`;

  log.info('Unapplied supplier payment', {
    paymentId: plan.paymentId, lines: plan.lines.length, amount: plan.amountUnapplied, userId,
  }, 'accounting');
  return plan;
}

async function buildPlan(companyId: string, input: PaymentUnapplyInput): Promise<PaymentUnapplyResult> {
  const pay = ((await sql`
    SELECT id, payment_number, status, total_amount, batch_id FROM supplier_payments
    WHERE id = ${input.paymentId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[])[0];
  // One reply for absent and foreign — the read is company-scoped.
  if (!pay) throw new UnapplyRefusal('Not found');
  const number = String(pay.payment_number ?? pay.id);
  const status = String(pay.status);

  if (status === 'draft' || status === 'approved') {
    throw new UnapplyRefusal(
      `Payment ${number} is ${status}: its allocations are a plan, not a settlement. Edit or cancel the `
      + 'payment instead.',
    );
  }
  if (status !== 'processed' && status !== 'reconciled') {
    throw new UnapplyRefusal(`Payment ${number} is ${status} and has nothing applied that can be taken back.`);
  }
  // A batch member's cash was posted by its batch's journal; it moves only
  // through the batch (K-063).
  if (pay.batch_id) {
    throw new UnapplyRefusal(`Payment ${number} belongs to batch ${String(pay.batch_id)} — undo it through its batch.`);
  }

  const rows = (await sql`
    SELECT pa.invoice_id, pa.amount_allocated, si.invoice_number, si.status,
           si.total_amount, COALESCE(si.amount_paid, 0) AS amount_paid, si.deleted_at
    FROM payment_allocations pa
    JOIN supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = ${companyId}::UUID
    WHERE pa.payment_id = ${input.paymentId}::UUID
      AND (${input.invoiceId ?? null}::UUID IS NULL OR pa.invoice_id = ${input.invoiceId ?? null}::UUID)
    ORDER BY pa.invoice_id`) as DbRow[];
  if (rows.length === 0) {
    throw new UnapplyRefusal(
      input.invoiceId
        ? `Payment ${number} is not applied to that bill.`
        : `Payment ${number} is not applied to any bill.`,
    );
  }

  const lines: UnapplyLine[] = [];
  for (const r of rows) {
    const invNumber = String(r.invoice_number);
    const amount = round2(Number(r.amount_allocated));
    const paid = round2(Number(r.amount_paid));
    // A soft-delete reverses the bill's journal and leaves its status alone:
    // restoring its balance would move money the ledger no longer carries.
    if (r.deleted_at != null) {
      throw new UnapplyRefusal(
        `Bill ${invNumber} has been deleted; its allocation from payment ${number} cannot be taken back here. `
        + 'Reconcile it by hand.',
      );
    }
    // Only a balance-derived bill has a balance to give back to: a cancelled
    // or written-off bill carrying an allocation is a defect to reconcile by hand.
    if (!FIFO_ELIGIBLE_STATUSES.includes(String(r.status))) {
      throw new UnapplyRefusal(
        `Bill ${invNumber} is ${String(r.status)}; its allocation from payment ${number} cannot be taken `
        + 'back here. Reconcile it by hand.',
      );
    }
    if (paid + EPS < amount) {
      throw new UnapplyRefusal(
        `Bill ${invNumber} shows R${paid.toFixed(2)} paid, less than the R${amount.toFixed(2)} payment `
        + `${number} applied — its balance and the allocation disagree. Reconcile it by hand.`,
      );
    }
    const before = round2(Number(r.total_amount) - paid);
    lines.push({ invoiceId: String(r.invoice_id), invoiceNumber: invNumber, amount, outstandingBefore: before, outstandingAfter: round2(before + amount) });
  }

  const allocatedAll = round2(Number(((await sql`
    SELECT COALESCE(SUM(amount_allocated), 0) AS a FROM payment_allocations WHERE payment_id = ${input.paymentId}::UUID`) as DbRow[])[0]!.a));
  const amountUnapplied = round2(lines.reduce((s, l) => s + l.amount, 0));
  const unappliedAfter = round2(Number(pay.total_amount) - (allocatedAll - amountUnapplied));
  return {
    paymentId: String(pay.id),
    paymentNumber: number,
    amountUnapplied,
    lines,
    paymentStatusAfter: unappliedAfter > EPS ? 'processed' : status,
    unappliedAfter,
  };
}
