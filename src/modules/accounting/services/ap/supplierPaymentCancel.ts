/**
 * Cancel a supplier payment that has not moved money — `draft` or `approved`.
 *
 * Until this existed an approved payment had no way out: `voidSupplierPayment`
 * takes only `processed`, and the process-time gate (K-063/K-066) refuses a
 * payment whose bill has since been cancelled, deleted or reassigned. Such a
 * payment sat `approved` for ever, and its allocations — counted as promised by
 * every later payment or batch — blocked the rest of the bill.
 *
 * A batch member is cancelled through its batch (`cancelBatch`), for the same
 * reason it is processed through it. Every refusal is raised before the UPDATE.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockSupplierPaymentForUpdate } from '../core/paymentLock';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { SupplierPaymentNotFoundError } from './supplierPaymentWorkflowService';

export async function cancelSupplierPayment(companyId: string, id: string): Promise<void> {
  if (!(await lockSupplierPaymentForUpdate(companyId, id))) throw new SupplierPaymentNotFoundError(id);
  const rows = (await sql`
    SELECT payment_number, status, batch_id FROM supplier_payments
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const row = rows[0];
  if (!row) throw new SupplierPaymentNotFoundError(id);
  if (row.batch_id) {
    throw new SupplierPaymentRefusal(
      `Payment ${String(row.payment_number)} belongs to a batch — cancel it through its batch.`,
    );
  }
  if (!['draft', 'approved'].includes(String(row.status))) {
    throw new SupplierPaymentRefusal(
      `Payment ${String(row.payment_number)} is ${String(row.status)} — only a draft or approved payment `
      + 'can be cancelled; void a processed one instead.',
    );
  }
  await sql`
    UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Cancelled supplier payment', { id }, 'accounting');
}
