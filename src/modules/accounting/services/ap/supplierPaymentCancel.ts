/**
 * Voiding or CANCELLING a supplier payment that has not moved money — `draft`
 * or `approved`.
 *
 * `voidSupplierPayment` used to accept only `processed` and threw a bare Error
 * otherwise, which the route answered 500. So an approved payment the
 * process-time gate refuses (a bill cancelled, deleted or reassigned since, or
 * the loser of a creation race) had no way out: it sat `approved` for ever, and
 * its allocation — counted as promised by every later payment or batch —
 * blocked the rest of the bill. Such a payment has no journal and has not
 * touched `amount_paid`, so voiding it is only a status change.
 *
 * A batch member is cancelled through its batch (`cancelBatch`), for the same
 * reason it is processed through it. The caller holds the payment row lock.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { lockSupplierPaymentForUpdate } from '../core/paymentLock';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { SupplierPaymentNotFoundError } from './supplierPaymentNotFound';

export async function voidUnprocessedPayment(
  companyId: string,
  payment: { id: string; paymentNumber: string; batchId?: string },
): Promise<void> {
  if (payment.batchId) {
    throw new SupplierPaymentRefusal(
      `Payment ${payment.paymentNumber} belongs to batch ${payment.batchId} — cancel it through its batch.`,
    );
  }
  const done = (await sql`
    UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${payment.id}::UUID AND company_id = ${companyId}::UUID AND status IN ('draft', 'approved')
    RETURNING id
  `) as DbRow[];
  // Never a 200 that did nothing: the guarded UPDATE matching no row means the
  // payment was not draft/approved after all.
  if (done.length === 0) {
    throw new SupplierPaymentRefusal(`Payment ${payment.paymentNumber} is not draft or approved and was not changed.`);
  }
  log.info('Voided unprocessed supplier payment', { id: payment.id }, 'accounting');
}

/**
 * CANCEL: the explicit "this payment will not be made" action, alongside Void.
 * Void is for money that moved (it reverses the journal and rolls `amount_paid`
 * back); cancel is only ever for money that did not, so it refuses a processed
 * or reconciled payment rather than leave its journal standing. It takes the
 * payment row lock `processSupplierPayment` takes first, so a cancel racing a
 * process has one outcome: whichever locks first wins and the other is refused.
 */
export async function cancelSupplierPayment(companyId: string, id: string, userId: string): Promise<void> {
  if (!(await lockSupplierPaymentForUpdate(companyId, id))) throw new SupplierPaymentNotFoundError(id);
  const rows = (await sql`
    SELECT payment_number, status, batch_id FROM supplier_payments
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const row = rows[0];
  if (!row) throw new SupplierPaymentNotFoundError(id);
  const status = String(row.status);
  const number = String(row.payment_number);
  if (status === 'processed' || status === 'reconciled') {
    throw new SupplierPaymentRefusal(
      `Payment ${number} is ${status} — its journal is posted. Use Void, which reverses it.`,
    );
  }
  if (status !== 'draft' && status !== 'approved') {
    throw new SupplierPaymentRefusal(`Payment ${number} is ${status} and cannot be cancelled.`);
  }
  await voidUnprocessedPayment(companyId, {
    id, paymentNumber: number, batchId: row.batch_id ? String(row.batch_id) : undefined,
  });
  log.info('Cancelled supplier payment', { id, userId, statusBefore: status }, 'accounting');
}
