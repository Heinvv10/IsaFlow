/**
 * Approving a single supplier payment (draft -> approved), and the approval
 * gate both of a payment's instruction steps consult (R-035 PR5). Split from
 * supplierPaymentWorkflowService, which was already over the file-size cap.
 *
 * Approve and process are each an instruction to pay (decision Q4), so each
 * runs the gate under the payment's row lock, before any write: process
 * re-checks because the money moves there — an approval taken before
 * enforcement was switched on, or one whose content (the payee's bank details
 * included, read live by the digest) has moved since, must not be paid.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { lockSupplierPaymentForUpdate } from '../core/paymentLock';
import { assertApprovalCleared } from '../gl/approvalGate';
import { getSupplierPaymentById } from './supplierPaymentService';
import { mapPaymentRow } from './supplierPaymentRow';
import { SupplierPaymentNotFoundError } from './supplierPaymentNotFound';
import type { SupplierPayment } from '../../types/ap.types';

/**
 * Throws ApprovalRequiredError unless the gate clears the payment. A batch
 * MEMBER is one line of its batch, the one approvable document (Hein,
 * 2026-10-06): it is cleared only by its BATCH's approval, never on its own —
 * the backstop (migration 867) judges a member the same way.
 */
export async function assertPaymentApprovalCleared(
  companyId: string,
  payment: Pick<SupplierPayment, 'id' | 'batchId'>,
): Promise<void> {
  if (payment.batchId) await assertApprovalCleared(companyId, 'payment_batch', payment.batchId);
  else await assertApprovalCleared(companyId, 'supplier_payment', payment.id);
}

export async function approveSupplierPayment(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierPayment> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  try {
    // The row lock first (5s-bounded, as processSupplierPayment takes it), so
    // the status and the gate are decided on a row nobody can approve, process
    // or cancel underneath. This used to read unlocked and UPDATE with no
    // status predicate: a racing approve wrote twice, and a cancel landing in
    // between was overwritten back to 'approved'.
    if (!(await lockSupplierPaymentForUpdate(companyId, id))) throw new SupplierPaymentNotFoundError(id);
    const payment = await getSupplierPaymentById(companyId, id);
    if (!payment) throw new SupplierPaymentNotFoundError(id);
    if (payment.status !== 'draft') throw new Error(`Cannot approve payment with status: ${payment.status}`);
    // R-035 PR5: before the write, so the route's 409 commits nothing.
    await assertPaymentApprovalCleared(companyId, payment);

    const rows = (await sql`
      UPDATE supplier_payments
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status = 'draft'
      RETURNING *
    `) as DbRow[];
    // Unreachable under the lock; refused rather than reported as approved if not.
    if (!rows[0]) throw new Error('Cannot approve payment with status: changed concurrently');
    return mapPaymentRow(rows[0]);
  } catch (err) {
    log.error('Failed to approve supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}
