/**
 * The receiver discards the F draft receipt an accepted `payment` message names (intercompany F, plan (k) Q1 / M-1 / M-2). A person with
 * Approve on Customers & AR (as the receipt cancel, customer-payments-action), in their own session, in the request's ONE transaction: the
 * message FOR UPDATE, then the receipt FOR UPDATE (`lockCustomerPaymentForUpdate`: the one order, M-3), then the database's
 * `intercompany_discard_payment_draft` (D4, migration 1031) cancels the draft and returns the message to `pending` with no target (the guard's
 * `redraft` system transition); one audit_log row (who, when, the reason, the message) is written in the same transaction. The allocation rows
 * stay (as a receipt cancel keeps them); a cancelled draft no longer claims anything on the invoice, so it is open again. Nothing posts.
 * A confirmed one is refused (`not_draft`); a concurrent confirm and discard serialise on the message: exactly one wins.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockCustomerPaymentForUpdate } from '../core/paymentLock';
import { logAuditOrThrow } from '../core/auditTrailService';
import { PaymentRefusal, type PaymentRefusalCode } from './paymentAcceptRules';
import { assertPaymentActor } from './paymentAcceptService';

type Row = Record<string, unknown>;

/** D4's refusal words as the service's refusals (none of them wrote anything). */
const D4: Readonly<Record<string, PaymentRefusalCode>> = Object.freeze({
  forbidden: 'no_approve', not_found: 'not_found', not_target: 'not_target', not_ic_draft: 'not_ic_draft', not_draft: 'not_draft',
});

export interface DiscardParams { companyId: string; messageId: string; userId: string; paymentId: string; reason: string }

export async function discardIcDraftReceipt(p: DiscardParams): Promise<{ messageId: string; status: 'pending'; paymentId: string }> {
  const { companyId, messageId, userId, paymentId, reason } = p;
  await assertPaymentActor(companyId, userId, 'approve');
  const [m] = (await sql`
    SELECT id FROM intercompany_messages WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment' FOR UPDATE
  `) as Row[];
  if (!m) throw new PaymentRefusal('not_found');
  const receipt = await lockCustomerPaymentForUpdate(companyId, paymentId);
  if (!receipt) throw new PaymentRefusal('not_ic_draft');
  const [d] = (await sql`
    SELECT ok, reason FROM public.intercompany_discard_payment_draft(${messageId}::UUID, ${paymentId}::UUID, ${reason})
  `) as Row[];
  if (d?.ok !== true) {
    const code = D4[String(d?.reason ?? '')];
    if (!code) throw new Error('the intercompany draft discard answered no known reason');
    throw new PaymentRefusal(code);
  }
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'customer_payment', entityId: paymentId, entityRef: String(receipt.payment_number ?? paymentId),
    changes: {
      fields: [{ field: 'status', old: 'draft', new: 'cancelled', label: 'Status' }],
      metadata: { event: 'ic_payment_draft_discarded', messageId, reason: reason.slice(0, 200) },
    },
  });
  log.info('Intercompany payment draft discarded', { companyId, messageId, paymentId }, 'intercompany');
  return { messageId, status: 'pending', paymentId };
}
