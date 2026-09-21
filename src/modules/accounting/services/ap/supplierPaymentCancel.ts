/**
 * Voiding a supplier payment that has not moved money — `draft` or `approved`.
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
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

export async function voidUnprocessedPayment(
  companyId: string,
  payment: { id: string; paymentNumber: string; batchId?: string },
): Promise<void> {
  if (payment.batchId) {
    throw new SupplierPaymentRefusal(
      `Payment ${payment.paymentNumber} belongs to batch ${payment.batchId} — cancel it through its batch.`,
    );
  }
  await sql`
    UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${payment.id}::UUID AND company_id = ${companyId}::UUID AND status IN ('draft', 'approved')
  `;
  log.info('Voided unprocessed supplier payment', { id: payment.id }, 'accounting');
}
