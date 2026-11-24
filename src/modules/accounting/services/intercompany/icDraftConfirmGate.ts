/**
 * The confirm gate on an F draft receipt (intercompany F, plan (k) H-3 / M-3, (l) LOW-2 / LOW-3). Called at the top of
 * `confirmCustomerPaymentInner` BEFORE the receipt row lock. An unlocked read of the draft's `bank_reference` / `payment_method`: a non-contra
 * receipt stamped `IC:<m>` where m is a `payment` message to THIS company is an F draft (P4-D's contra receipts are stamped after their confirm
 * and are never gated). Then, in the one lock order (message FOR UPDATE, then the caller's receipt lock, then invoices): the message is locked
 * here, the caller locks the receipt and calls the returned re-check, which re-reads the stamp (changed under the caller: 409, retry) and
 * refuses unless the receiver's state word (`intercompany_payment_message_state`, D2) is `target_ok` AND the message targets THIS receipt.
 * `target_ok` implies the payer still stands, the link and the connection hold and the receiver's flag is on. A stamp that names no payment
 * message of this company is refused too (round 1 LOW-3: the gate fails closed), and that draft is discarded alone. A worker never self-approves;
 * a person may confirm a draft they created (LOW-3, as P4-D).
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { ReceiptRefusal } from '../ar/receiptRefusal';
import { stateSentence } from './paymentAcceptRules';
import type { PaymentState } from './paymentInboxTypes';

type Row = Record<string, unknown>;
const STAMP = /^IC:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** (round 1 LOW-3) The stamp names no payment message of this company: the draft is refused, never confirmed (it fails CLOSED). */
export const IC_ORPHAN_SENTENCE = 'its payment message is not one this company received (it is gone, or the stamp names another).';

export const IC_DRAFT_REFUSED = (why: string) =>
  `This receipt was drafted from an intercompany payment message and cannot be confirmed now: ${why || 'its message no longer matches it.'} `
  + 'Discard the draft instead (the Intercompany chip on this receipt, or the intercompany payments page). Nothing was posted.';

/** Null when the receipt is not an F draft (nothing to gate); else the re-check to run once the caller holds the receipt row. */
export async function icDraftConfirmGate(companyId: string, paymentId: string): Promise<(() => Promise<void>) | null> {
  const [p] = (await sql`
    SELECT bank_reference, payment_method FROM customer_payments WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];
  const stamp = typeof p?.bank_reference === 'string' ? STAMP.exec(p.bank_reference.trim()) : null;
  if (!p || p.payment_method === 'contra' || !stamp) return null;
  const messageId = stamp[1]!.toLowerCase();
  // the message first (M-3): an accept, a discard and this confirm of the same draft serialise on it
  const [m] = (await sql`
    SELECT id, status, target_doc_type, target_doc_id FROM intercompany_messages
     WHERE id = ${messageId}::UUID AND to_company_id = ${companyId}::UUID AND kind = 'payment'
       FOR UPDATE
  `) as Row[];
  // (round 1 LOW-3) no such message: the draft still carries the binding stamp, so it is refused, not confirmed as an ordinary receipt; it is
  // discarded through the discard route (D4's orphan path), which the receipt's Intercompany chip offers
  if (!m) {
    return async () => {
      const [now] = (await sql`SELECT bank_reference FROM customer_payments WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
      if (!now || now.bank_reference !== p.bank_reference) {
        throw new ReceiptRefusal('This receipt changed while it was being confirmed. Reload it and try again.', { retryable: true });
      }
      log.info('Intercompany draft receipt confirm refused: no such payment message', { companyId, paymentId, messageId }, 'intercompany');
      throw new ReceiptRefusal(IC_DRAFT_REFUSED(IC_ORPHAN_SENTENCE));
    };
  }
  return async () => {
    const [now] = (await sql`
      SELECT bank_reference, payment_method FROM customer_payments WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    if (!now || now.bank_reference !== p.bank_reference || now.payment_method !== p.payment_method) {
      throw new ReceiptRefusal('This receipt changed while it was being confirmed. Reload it and try again.', { retryable: true });
    }
    const [s] = (await sql`SELECT state FROM public.intercompany_payment_message_state(${messageId}::UUID)`) as Row[];
    const [cur] = (await sql`SELECT status, target_doc_type, target_doc_id FROM intercompany_messages WHERE id = ${messageId}::UUID`) as Row[];
    const state = String(s?.state ?? 'check_failed') as PaymentState;
    const targetsThis = cur?.status === 'accepted' && cur.target_doc_type === 'customer_payment'
      && String(cur.target_doc_id ?? '').toLowerCase() === paymentId.toLowerCase();
    if (state !== 'target_ok' || !targetsThis) {
      log.info('Intercompany draft receipt confirm refused', { companyId, paymentId, messageId, state, targetsThis }, 'intercompany');
      throw new ReceiptRefusal(IC_DRAFT_REFUSED(targetsThis ? stateSentence(state) : ''));
    }
  };
}
