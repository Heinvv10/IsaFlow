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
 * route banks the receipt but carries no fee, and it exists to beat the webhook,
 * so the fee arrives on a delivery that finds the receipt already there.
 *
 * Being a separate entry also means `cancelCustomerPayment` does not reverse it:
 * it reverses only the receipt's own `gl_journal_entry_id`. That is deliberate
 * and correct — Paystack keeps its fee whether or not the receipt is cancelled,
 * so the expense and its bank credit should survive. Reverse it by hand in the
 * rare case where the gateway actually refunded the fee too.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { GATEWAY_RECEIPT_AGENT, EPS, type GatewayInvoiceReceipt } from './gatewayInvoiceReceiptService';

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
  if (!Number.isFinite(fee) || fee <= EPS) return;
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
  const existing = await sql<{ id: string }>`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${receipt.companyId}::UUID
      AND reference = ${receipt.reference}
      AND posting_agent = ${GATEWAY_RECEIPT_AGENT}
      AND status IS DISTINCT FROM 'reversed'
    LIMIT 1
  `;
  if (existing[0]) return;

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
  log.info('Posted gateway fee', { reference: receipt.reference, fee, journalEntryId: je.id }, 'accounting');
}
