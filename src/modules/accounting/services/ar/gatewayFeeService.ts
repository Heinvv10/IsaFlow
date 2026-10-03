/**
 * The gateway's fee leg.
 *
 * The receipt in `gatewayInvoiceReceiptService` debits Bank with the GROSS
 * amount, but Paystack settles net of its fee, so without this entry the bank
 * account can never be reconciled against the statement and no card-fee expense
 * is ever recorded. Posted as its own DR expense / CR Bank journal rather than a
 * third line, to leave the canonical AR posting untouched.
 *
 * Separate from the receipt's own idempotency on purpose: the portal verify
 * route exists to beat the webhook, and its response may carry no `fees`, so the
 * fee can arrive on a delivery that finds the receipt already there. Whichever of
 * the two carries `fees` first posts the leg; this idempotency stops the other.
 *
 * Being a separate entry also means `cancelCustomerPayment` does not reverse it:
 * it reverses only the receipt's own `gl_journal_entry_id`. That is deliberate
 * and correct — Paystack keeps its fee whether or not the receipt is cancelled,
 * so the expense and its bank credit should survive. Reverse it by hand in the
 * rare case where the gateway actually refunded the fee too.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { GATEWAY_RECEIPT_AGENT, type GatewayInvoiceReceipt } from './gatewayInvoiceReceiptService';

/**
 * The expense account is the `admin_expense` system role — there is no
 * bank-charges role in this chart, and `writeOffService` already resolves it for
 * the same reason. Best-effort by design: when the payload carries no fee, or
 * the role is unresolved, the receipt still stands and the gap is logged,
 * because throwing here would turn a settled card payment into a 500.
 *
 * Known limit: a South African Paystack fee carries VAT, and booking it gross to
 * admin_expense claims no input VAT. Revisit when the chart gains a
 * merchant-fees role.
 */
export async function postGatewayFee(
  receipt: GatewayInvoiceReceipt,
  actorId: string,
  bankAccountId: string | null,
  paymentDate: string,
): Promise<void> {
  const fee = Number(receipt.feeRand ?? 0);
  // Any whole cent posts (R-181): `fee <= 0.01` dropped a merchant's R0.01 share and left Bank a
  // cent above the deposit. Less than a whole cent is nothing to post.
  if (!Number.isFinite(fee) || Math.round(fee * 100) < 1) return;
  if (!bankAccountId) {
    log.warn(
      'Gateway fee not posted — the receipt has no bank account',
      { reference: receipt.reference, fee },
      'accounting',
    );
    return;
  }

  const description = `Paystack fee ${receipt.reference}`;
  // Its own idempotency, because this now runs on the dedupe path too: the
  // verify route banks the receipt, then the webhook arrives with the fee.
  // Keyed on the reference COLUMN plus this service's posting agent, not on the
  // description: a free-text match would let any journal a person happened to
  // describe the same way suppress the fee, and would break silently the day the
  // wording changed. The receipt's own journal carries the same agent with a NULL
  // reference, so it cannot collide. IS DISTINCT FROM because status is nullable
  // and `NULL <> 'reversed'` is NULL — the row would escape the guard and the fee
  // would post twice.
  if (await feeJournalExists(receipt)) return;

  let expenseAccountId: string;
  try {
    expenseAccountId = String((await getSystemAccount('admin_expense', receipt.companyId)).id);
  } catch (err) {
    log.warn(
      'Gateway fee not posted — no admin_expense system account; bank will not reconcile by the fee',
      { reference: receipt.reference, fee, error: err instanceof Error ? err.message : String(err) },
      'accounting',
    );
    return;
  }

  // R-185: the SELECT above is a fast path, not the guarantee. Two deliveries can both pass it;
  // the partial unique index (migration 852) refuses the second insert with 23505. The savepoint
  // rolls back whatever this block wrote, including a draft left by a failed post, so the re-read
  // sees only another delivery's journal. Decided by outcome: present means the fee is posted;
  // absent means this error is the real failure.
  let journalEntryId: string;
  try {
    journalEntryId = await withSavepoint('gateway_fee_post', async () => {
      const je = await createJournalEntry(
        receipt.companyId,
        {
          entryDate: paymentDate,
          description,
          source: 'auto_payment',
          reference: receipt.reference,
          lines: [
            { glAccountId: expenseAccountId, debit: fee, credit: 0, description: 'Paystack transaction fee' },
            { glAccountId: bankAccountId, debit: 0, credit: fee, description: 'Paystack transaction fee' },
          ],
        },
        actorId,
        { postingAgent: GATEWAY_RECEIPT_AGENT },
      );
      await postJournalEntry(receipt.companyId, je.id, actorId);
      return je.id;
    });
  } catch (err) {
    if (!(await feeJournalExists(receipt))) throw err;
    log.info('Gateway fee already posted by a concurrent delivery', {
      reference: receipt.reference,
      fee,
      // What this delivery's attempt raised; no stack. On a lost race, a 23505 on either
      // uq_gl_je_company_entry_number (the winner still uncommitted at this insert: the entry-number
      // trigger is MAX+1 over committed rows, so both take one number; the common case) or
      // ux_gl_je_gateway_fee_reference (the winner committed after this call's guard).
      code: (err as { code?: unknown }).code,
      error: err instanceof Error ? err.message : String(err),
    }, 'accounting');
    return;
  }
  log.info('Posted gateway fee', { reference: receipt.reference, fee, journalEntryId }, 'accounting');
}

/**
 * The live fee journal for this reference. Same predicate as the partial unique index
 * `ux_gl_je_gateway_fee_reference` (migration 852), so the guard and the index agree.
 */
async function feeJournalExists(receipt: GatewayInvoiceReceipt): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${receipt.companyId}::UUID
      AND reference = ${receipt.reference}
      AND posting_agent = ${GATEWAY_RECEIPT_AGENT}
      AND status IS DISTINCT FROM 'reversed'
    LIMIT 1
  `;
  return rows.length > 0;
}
