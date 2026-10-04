/**
 * R-127 (Hein): the sanctioned undo of a bank-first settlement.
 *
 * A settlement payment carries the provisional's RECLASS as its journal, so a
 * plain void (reverse the payment journal, un-apply the bills) would put the
 * bill's expense and VAT back twice. The undo is two steps instead:
 *   1. Unapply (the payment page's Unapply, or `unapply_supplier_payment`)
 *      moves only the subledger: the bill reopens, the payment keeps its cash
 *      unapplied and still holds the provisional's claim.
 *   2. Voiding that FULLY UNAPPLIED payment — here, from both void paths
 *      (`supplierPaymentGates.voidIfUnprocessed` and
 *      `core/paymentVoidService.voidPaymentDocument`) — cancels the payment,
 *      which releases the claim, reverses the reclass AND the provisional, and
 *      returns the bank line to 'imported' with its provisional link cleared.
 *
 * After it: the bill stays open on AP, booked once by its own journal; the
 * provisional's expense and VAT are gone; the bank line is free to allocate, and
 * allocating it to the bill books the payment once. Nothing is double-booked at
 * any step. All of it runs in ONE savepoint; a refusal is raised before any write.
 *
 * Lock order: the callers hold the payment row; the bank line is taken after it
 * (bounded, `lockBankTransactionForUpdate`) — the reverse of the canonical bank
 * line → payment order. The only other writer of a provisional's line with its
 * payment is this function, so contention there surfaces as a retryable
 * timeout, not a deadlock cycle.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseJournalEntry } from '../gl/journalEntryService';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import type { VatLockRoll } from '../gl/journalEntryReversalVatRoll';
import { lockBankTransactionForUpdate } from '../bank/bankTxLock';
import { reconciliationLockOf, refuseLockedCash } from '../bank/reconciledCash';
import type { VoidPaymentResult } from '../core/paymentVoidService';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { UNAPPLY_REMEDY } from './provisionalSettlementGuards';
import { lockStandingChainHead } from '../shared/journalChainHead';

export interface SettlementPaymentRef {
  id: string;
  paymentNumber: string | null;
  settlesProvisionalJeId: string;
  /** The payment's journal — the reclass. Always set: settleInvoiceFromProvisional inserts it WITH it. */
  journalEntryId: string | null;
}

export async function voidProvisionalSettlement(
  companyId: string,
  payment: SettlementPaymentRef,
  userId: string,
  opts?: PostingActorOpts,
): Promise<{ bankTransactionId: string | null; vatLockRoll: VatLockRoll | null; reclassVatLockRoll: VatLockRoll | null }> {
  const reclassJournalId = payment.journalEntryId;
  if (!reclassJournalId) throw new Error(`Settlement payment ${payment.id} has no journal`);
  return withSavepoint('void_provisional_settlement', async () => {
    const number = payment.paymentNumber ?? payment.id;
    const [applied] = (await sql`
      SELECT COALESCE(SUM(pa.amount_allocated), 0) AS amount,
             string_agg(si.invoice_number, ', ' ORDER BY si.invoice_number) AS bills
      FROM payment_allocations pa
      JOIN supplier_payments sp ON sp.id = pa.payment_id
      JOIN supplier_invoices si ON si.id = pa.invoice_id AND si.company_id = sp.company_id
      WHERE sp.id = ${payment.id}::UUID AND sp.company_id = ${companyId}::UUID
    `) as DbRow[];
    if (Number(applied?.amount ?? 0) > 0) {
      throw new SupplierPaymentRefusal(
        `Payment ${number} settled ${String(applied!.bills)} out of a bank-first provisional journal. Voiding it `
        + 'while it still pays a bill would reverse only its reclass and book that bill\'s expense and VAT twice. '
        + `Use ${UNAPPLY_REMEDY} first; voiding the unapplied payment then undoes the whole settlement.`,
      );
    }

    const [line] = (await sql`
      SELECT id FROM bank_transactions
      WHERE provisional_je_id = ${payment.settlesProvisionalJeId}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    const bankTransactionId = line ? String(line.id) : null;
    if (bankTransactionId) {
      const tx = await lockBankTransactionForUpdate(companyId, bankTransactionId);
      const lock = tx ? await reconciliationLockOf(companyId, tx) : null;
      if (lock?.kind === 'completed') refuseLockedCash(lock, 'This bank line'); // D12: 409, reopen it first
      if (lock) {
        throw new SupplierPaymentRefusal(
          `The bank line behind payment ${number} is reconciled, so its bank-first settlement cannot be undone `
          + 'here. Take the line out of its reconciliation first.',
        );
      }
    }

    const cancelled = (await sql`
      UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW()
      WHERE id = ${payment.id}::UUID AND company_id = ${companyId}::UUID AND status IN ('processed', 'reconciled')
      RETURNING id
    `) as DbRow[];
    if (cancelled.length !== 1) throw new Error('Payment state changed concurrently — void aborted');

    // The claim is released above, so neither reversal is refused as half a settlement.
    // The provisional is reversed at its chain HEAD (D8): one reversed and
    // re-reversed stands through its second contra, and is stamped reversed. A
    // chain already out (only a forged row or the pre-round-4 B1 race can leave
    // a settlement on one) reverses nothing; the bank line is freed either way.
    const reclass = await reverseJournalEntry(companyId, reclassJournalId, userId, opts);
    const provisionalHead = await lockStandingChainHead(companyId, payment.settlesProvisionalJeId,
      (m) => new SupplierPaymentRefusal(m));
    const provisional = provisionalHead ? await reverseJournalEntry(companyId, provisionalHead, userId, opts) : null;
    if (bankTransactionId) {
      await sql`
        UPDATE bank_transactions SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
        WHERE id = ${bankTransactionId}::UUID AND company_id = ${companyId}::UUID
      `;
    }
    log.info('Bank-first settlement undone', {
      companyId, paymentId: payment.id, reclassJournalId,
      provisionalJournalId: payment.settlesProvisionalJeId, bankTransactionId,
    }, 'accounting');
    return {
      bankTransactionId,
      vatLockRoll: provisional?.vatLockRoll ?? null,
      reclassVatLockRoll: reclass.vatLockRoll ?? null,
    };
  });
}

/** `voidPaymentDocument`'s answer for a settlement payment (MCP `void_payment`). */
export async function voidSettlementDocument(
  companyId: string,
  payment: { id: string; paymentNumber: string | null; settlesProvisionalJeId: string | null; journalEntryId: string | null },
  userId: string,
  opts?: PostingActorOpts,
): Promise<VoidPaymentResult> {
  if (!payment.settlesProvisionalJeId) throw new Error(`Payment ${payment.id} is not a settlement`);
  const undone = await voidProvisionalSettlement(companyId, {
    ...payment, settlesProvisionalJeId: payment.settlesProvisionalJeId,
  }, userId, opts);
  return {
    paymentId: payment.id,
    paymentNumber: payment.paymentNumber,
    kind: 'supplier',
    invoicesReopened: 0,
    amountUnapplied: 0,
    journalEntryId: payment.journalEntryId,
    bankTransactionId: undone.bankTransactionId,
    vatLockRoll: undone.vatLockRoll,
    reclassVatLockRoll: undone.reclassVatLockRoll,
  };
}
