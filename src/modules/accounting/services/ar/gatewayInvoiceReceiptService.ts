/**
 * Gateway invoice receipts (Paystack).
 *
 * A card payment against a customer invoice used to be applied with a bare
 * `UPDATE customer_invoices SET amount_paid` in two places — the webhook's
 * charge.success branch and the portal return page's verify fallback. Neither
 * wrote a `customer_payments` row or a journal, so the invoice read paid while
 * accounts receivable stayed overstated and the bank account was never debited
 * (K-036).
 *
 * This routes both call sites through the canonical AR posting instead:
 * `confirmCustomerPayment`, which posts DR Bank / CR Receivable for the whole
 * receipt and stamps `gl_journal_entry_id`.
 *
 * The caller must already be inside a transaction (see
 * `withPublicRouteTransaction`) so a GL failure cannot leave the invoice marked
 * paid, and every query below carries `company_id` because that path runs with
 * RLS bypassed.
 */

import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { confirmCustomerPayment } from './customerPaymentAllocationService';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';

/** posting_agent stamp: unattended, so never `human:<userId>`. */
export const GATEWAY_RECEIPT_AGENT = 'system:paystack-receipt:v1';

/** A cent. Matches confirmCustomerPayment's own settle tolerance. */
const EPS = 0.01;

export interface GatewayInvoiceReceipt {
  companyId: string;
  invoiceId: string;
  /** Settled amount in rand (Paystack reports cents). */
  amountRand: number;
  /** Paystack reference — the idempotency key, stored as bank_reference. */
  reference: string;
  /**
   * When the gateway settled it. K-035 makes a delivery reprocess hours or days
   * later, so dating the receipt at processing time would book a 30 September
   * payment into October — the wrong fiscal and VAT period.
   */
  paidAt?: string | null;
  /** Gateway fee in rand, deducted from the deposit. See postGatewayFee. */
  feeRand?: number | null;
}

interface InvoiceRow {
  client_id: string | null;
  created_by: string;
  total_amount: string;
  amount_paid: string | null;
}

/**
 * Record a settled gateway payment against a customer invoice: one confirmed
 * `customer_payments` row for the WHOLE receipt, allocated to the invoice up to
 * what the invoice still owes, and posted to the ledger by the same code path a
 * manual receipt uses.
 *
 * Idempotent on `reference`: a second call for the same Paystack reference
 * (webhook and verify route both firing, or a webhook redelivery) records
 * nothing and returns null.
 */
export async function recordGatewayInvoiceReceipt(
  receipt: GatewayInvoiceReceipt,
): Promise<{ paymentId: string; journalEntryId?: string } | null> {
  const { companyId, invoiceId, amountRand, reference } = receipt;

  const already = await sql<{ id: string }>`
    SELECT id FROM customer_payments
    WHERE company_id = ${companyId}::UUID
      AND bank_reference = ${reference}
      AND status <> 'cancelled'
    LIMIT 1
  `;
  if (already[0]) {
    log.info('Gateway receipt already recorded', { reference, invoiceId }, 'accounting');
    return null;
  }

  const invRows = await sql<InvoiceRow>`
    SELECT COALESCE(client_id, customer_id) AS client_id, created_by,
           total_amount::text AS total_amount, amount_paid::text AS amount_paid
    FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
  const invoice = invRows[0];
  if (!invoice || !invoice.client_id) {
    throw new Error(`Gateway receipt: invoice ${invoiceId} not found for company ${companyId}`);
  }

  // The gateway can settle more than the invoice still owes — an EFT part-payment
  // landing between the payment link and the card charge is enough. The excess is
  // real cash in the bank, so the receipt is banked in full and only the part the
  // invoice can absorb is allocated; the remainder stays on the customer as an
  // unapplied receipt. Truncating the receipt to fit would drop that cash.
  const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid ?? 0);
  const allocated = Math.max(0, Math.min(amountRand, outstanding));
  const unallocated = amountRand - allocated;
  if (unallocated > EPS) {
    log.warn(
      'Gateway receipt exceeds the invoice balance — the excess is banked as an unapplied receipt',
      { reference, invoiceId, amountRand, outstanding, unallocated },
      'accounting',
    );
  }

  const bankAccount = await getSystemAccount('bank', companyId);
  // customer_invoices.created_by is `varchar` while customer_payments.created_by
  // is `uuid`; a non-UUID actor (e.g. an imported 'sage-import') would abort the
  // insert with 22P02 on every redelivery. Same helper the GL side uses.
  const actorId = await resolveUserUuid(String(invoice.created_by));
  const paymentDate = fmtDate(receipt.paidAt ? new Date(receipt.paidAt) : new Date());

  // Written here rather than through createCustomerPayment: that service
  // requires allocations to equal the payment total, an invariant an
  // over-settlement cannot satisfy, and the only way to satisfy it is to drop
  // the excess. Its balance validation is replaced by the clamp above.
  const paymentId = randomUUID();
  await sql`
    INSERT INTO customer_payments (
      id, company_id, client_id, payment_date, total_amount, payment_method,
      bank_reference, bank_account_id, description, created_by
    ) VALUES (
      ${paymentId}::UUID, ${companyId}::UUID, ${invoice.client_id}::UUID, ${paymentDate},
      ${amountRand}, 'card', ${reference}, ${String(bankAccount.id)}::UUID,
      ${`Paystack card payment ${reference}`}, ${actorId}::UUID
    )
  `;
  if (allocated > EPS) {
    await sql`
      INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
      VALUES (${paymentId}::UUID, ${invoiceId}::UUID, ${allocated})
    `;
  }

  const confirmed = await confirmCustomerPayment(companyId, paymentId, actorId, {
    postingAgent: GATEWAY_RECEIPT_AGENT,
  });
  await postGatewayFee(receipt, actorId, String(bankAccount.id), paymentDate);

  log.info(
    'Recorded gateway invoice receipt',
    { reference, invoiceId, paymentId, allocated, unallocated,
      journalEntryId: confirmed.glJournalEntryId },
    'accounting',
  );
  return { paymentId, journalEntryId: confirmed.glJournalEntryId };
}

/**
 * Book the gateway's fee so the bank GL matches the NET deposit on the statement.
 *
 * The receipt above debits Bank with the gross amount, but Paystack settles net
 * of its fee, so without this leg the bank account can never be reconciled and
 * no card-fee expense is ever recorded. Posted as its own DR expense / CR Bank
 * entry rather than as a third line, to leave the canonical AR posting untouched.
 *
 * The expense account is the `admin_expense` system role — there is no
 * bank-charges role in this chart, and that is an accounting-policy choice worth
 * overruling if the business wants a dedicated account. Best-effort by design:
 * when the fee is absent from the payload or the role is unresolved, the receipt
 * still stands and the gap is logged, because failing here would turn a settled
 * card payment into a 500.
 */
async function postGatewayFee(
  receipt: GatewayInvoiceReceipt,
  actorId: string,
  bankAccountId: string,
  paymentDate: string,
): Promise<void> {
  const fee = Number(receipt.feeRand ?? 0);
  if (!Number.isFinite(fee) || fee <= EPS) return;

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
      description: `Paystack fee ${receipt.reference}`,
      source: 'auto_payment',
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
