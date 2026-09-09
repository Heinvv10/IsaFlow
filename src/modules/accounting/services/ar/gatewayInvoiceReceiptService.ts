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
 * This routes both call sites through the canonical AR path instead:
 * `createCustomerPayment` + `confirmCustomerPayment`, which posts
 * DR Bank / CR Receivable and stamps `gl_journal_entry_id`.
 *
 * The caller must already be inside a transaction (see `withPublicRouteTransaction`)
 * so a GL failure cannot leave the invoice marked paid.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { createCustomerPayment, confirmCustomerPayment } from './customerPaymentService';
import { getSystemAccount } from '../gl/systemAccountResolver';

/** posting_agent stamp: unattended, so never `human:<userId>`. */
export const GATEWAY_RECEIPT_AGENT = 'system:paystack-receipt:v1';

export interface GatewayInvoiceReceipt {
  companyId: string;
  invoiceId: string;
  /** Settled amount in rand (Paystack reports cents). */
  amountRand: number;
  /** Paystack reference — the idempotency key, stored as bank_reference. */
  reference: string;
}

interface InvoiceRow {
  client_id: string | null;
  created_by: string;
  total_amount: string;
  amount_paid: string | null;
}

/**
 * Record a settled gateway payment against a customer invoice: one
 * `customer_payments` row allocated to the invoice, confirmed so the ledger
 * gets DR Bank / CR Receivable and the invoice's `amount_paid` is updated by
 * the same code path a manual receipt uses.
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

  // The gateway can settle more than the invoice still owes (a second card
  // payment on an already-settled invoice). The AR path cannot represent an
  // over-allocation, so allocate the outstanding balance and say so.
  const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid ?? 0);
  const allocated = Math.min(amountRand, outstanding);
  if (allocated <= 0.005) {
    log.warn(
      'Gateway receipt exceeds the invoice balance — nothing allocated',
      { reference, invoiceId, amountRand, outstanding },
      'accounting',
    );
    return null;
  }

  const bankAccount = await getSystemAccount('bank', companyId);

  // created_by is NOT NULL and a gateway callback has no user; the invoice's
  // author is the company-scoped actor already on the record.
  const actorId = String(invoice.created_by);

  const payment = await createCustomerPayment(
    companyId,
    {
      clientId: String(invoice.client_id),
      paymentDate: fmtDate(new Date()),
      totalAmount: allocated,
      paymentMethod: 'card',
      bankReference: reference,
      bankAccountId: String(bankAccount.id),
      description: `Paystack card payment ${reference}`,
      allocations: [{ invoiceId, amount: allocated }],
    },
    actorId,
  );

  const confirmed = await confirmCustomerPayment(companyId, payment.id, actorId, {
    postingAgent: GATEWAY_RECEIPT_AGENT,
  });

  log.info(
    'Recorded gateway invoice receipt',
    { reference, invoiceId, paymentId: confirmed.id, journalEntryId: confirmed.glJournalEntryId },
    'accounting',
  );
  return { paymentId: confirmed.id, journalEntryId: confirmed.glJournalEntryId };
}
