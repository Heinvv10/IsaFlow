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
import { getSystemAccount } from '../gl/systemAccountResolver';
import { postGatewayFee } from './gatewayFeeService';
import { spendPaymentLinkOfRequest } from './portalLinkCharge';
import {
  firstReportedAmountCents,
  flagSettlementForReview,
  isBookCurrency,
  merchantFee,
  receiptDescription,
  settledCharge,
  type ReportedCharge,
} from './gatewaySettlementReview';
import { decideGatewayAllocation } from './gatewayReceiptAllocation';

/** posting_agent stamp: unattended, so never `human:<userId>`. */
export const GATEWAY_RECEIPT_AGENT = 'system:paystack-receipt:v1';

/** A cent. Matches confirmCustomerPayment's own settle tolerance. */
export const EPS = 0.01;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GatewayInvoiceReceipt {
  companyId: string;
  invoiceId: string;
  /** What the checkout asked for: `paystack_payment_requests.amount_cents`. */
  requestedCents: number;
  /**
   * What Paystack reports it received. This, not the request, is banked
   * (R-181); a difference is flagged for review. See gatewaySettlementReview.
   */
  reported: ReportedCharge;
  /** Paystack reference — the idempotency key, stored as bank_reference. */
  reference: string;
  /**
   * When the gateway settled it. K-035 makes a delivery reprocess hours or days
   * later, so dating the receipt at processing time would book a 30 September
   * payment into October — the wrong fiscal and VAT period.
   */
  paidAt?: string | null;
  /**
   * Gateway fee in rand, deducted from the deposit. The part the customer paid on
   * top of `requested_amount` is not the merchant's expense (`merchantFee`). See
   * postGatewayFee.
   */
  feeRand?: number | null;
}

interface InvoiceRow {
  client_id: string | null;
  created_by: string;
}

/**
 * Record a settled gateway payment against a customer invoice: one confirmed
 * `customer_payments` row for the WHOLE receipt, allocated to the invoice up to
 * what the invoice still owes (decided under the invoice's row lock), and posted
 * to the ledger by the same code path a manual receipt uses. The receipt is what
 * Paystack reported; an invoice outside the ledger (draft, pending approval,
 * cancelled, soft-deleted) is allocated nothing, and any review reason flags the
 * request (R-181).
 *
 * Idempotent on `reference`: a second call for the same Paystack reference
 * (webhook and verify route both firing, or a webhook redelivery) banks nothing,
 * posts only a missing fee, compares its amount with what was banked, and
 * returns null.
 */
export async function recordGatewayInvoiceReceipt(
  receipt: GatewayInvoiceReceipt,
): Promise<{ paymentId: string; journalEntryId?: string } | null> {
  const { companyId, invoiceId, reference } = receipt;
  // R-167: a settled charge spends the portal link it came from, whichever of the webhook and
  // the verify route gets here first (both run this in their settlement transaction).
  await spendPaymentLinkOfRequest(companyId, reference);
  const charge = settledCharge(receipt.requestedCents, receipt.reported);
  const amountRand = charge.cents / 100;

  const already = await sql<{
    id: string;
    created_by: string;
    bank_account_id: string | null;
    payment_date: string;
    total_amount: string;
    description: string | null;
  }>`
    SELECT id, created_by::text AS created_by, bank_account_id::text AS bank_account_id,
           payment_date::text AS payment_date, total_amount::text AS total_amount, description
    FROM customer_payments
    WHERE company_id = ${companyId}::UUID
      AND bank_reference = ${reference}
      AND status IS DISTINCT FROM 'cancelled'
    LIMIT 1
  `;
  if (already[0]) {
    // The receipt is already banked — by the webhook, a redelivery, or the
    // portal verify route. The FEE still may not be: verify's response may carry
    // no `fees`, and returning here used to lose the fee leg for every customer
    // who reached the return page. Post it (once; postGatewayFee is idempotent)
    // against the receipt that already exists, in that receipt's period.
    log.info('Gateway receipt already recorded', { reference, invoiceId }, 'accounting');
    const bankedRand = Number(already[0].total_amount);
    // Two disagreements: the figure each would bank, and Paystack's own `amount` (PR #618 LOW-5).
    const firstAmountCents = firstReportedAmountCents(already[0].description, Math.round(bankedRand * 100));
    const reportedAmountCents = typeof receipt.reported.amountCents === 'number' ? receipt.reported.amountCents : null;
    const disagrees = Math.abs(bankedRand - amountRand) > EPS
      || (reportedAmountCents !== null && reportedAmountCents !== firstAmountCents);
    const fee = merchantFee(receipt.feeRand, receipt.reported, Math.round(bankedRand * 100));
    await postGatewayFee(
      { ...receipt, feeRand: fee.feeRand },
      already[0].created_by,
      already[0].bank_account_id,
      already[0].payment_date,
    );
    // This report's own reasons too (a currency or a missing amount the first report did not have).
    const reviews = [
      ...charge.reviews,
      ...(disagrees ? ['amount_disagrees_with_first_report'] : []),
      ...fee.reviews,
    ];
    if (reviews.length > 0) {
      await flagSettlementForReview(companyId, reference, reviews, {
        paymentId: already[0].id, invoiceId, bankedRand, reportedRand: amountRand, firstAmountCents,
        reportedCents: receipt.reported.amountCents, reportedCurrency: receipt.reported.currency,
      });
    }
    return null;
  }

  const invRows = await sql<InvoiceRow>`
    SELECT COALESCE(client_id, customer_id) AS client_id, created_by
    FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
  const invoice = invRows[0];
  if (!invoice || !invoice.client_id) {
    throw new Error(`Gateway receipt: invoice ${invoiceId} not found for company ${companyId}`);
  }

  const bankAccount = await getSystemAccount('bank', companyId);
  const actorId = await resolveCompanyActor(companyId, String(invoice.created_by));
  const paymentDate = settlementDate(receipt);
  // A non-ZAR charge is banked as reported (Hein) and says so on the receipt.
  const description = receiptDescription(reference, receipt.reported, charge.cents);

  // Written here rather than through createCustomerPayment: that service
  // requires allocations to equal the payment total, an invariant an
  // over-settlement cannot satisfy, and the only way to satisfy it is to drop
  // the excess. Its balance validation is carried by decideGatewayAllocation.
  // The payment row comes BEFORE the invoice lock: payment-then-invoice.
  const paymentId = randomUUID();
  await sql`
    INSERT INTO customer_payments (
      id, company_id, client_id, payment_date, total_amount, payment_method,
      bank_reference, bank_account_id, description, created_by
    ) VALUES (
      ${paymentId}::UUID, ${companyId}::UUID, ${invoice.client_id}::UUID, ${paymentDate},
      ${amountRand}, 'card', ${reference}, ${String(bankAccount.id)}::UUID,
      ${description}, ${actorId}::UUID
    )
  `;
  // A non-ZAR figure never settles a ZAR invoice: banked (Hein), left unapplied, flagged.
  const plan = await decideGatewayAllocation(companyId, invoiceId, amountRand, reference,
    isBookCurrency(receipt.reported) ? null : 'unapplied_currency');
  // The customer as read under the lock: a merge committed since the unlocked read moved the
  // invoice, and the receipt follows it rather than staying on the merged-away customer.
  if (plan.clientId && plan.clientId !== invoice.client_id) {
    await sql`
      UPDATE customer_payments SET client_id = ${plan.clientId}::UUID
      WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID
    `;
  }
  if (plan.allocated > EPS) {
    await sql`
      INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
      VALUES (${paymentId}::UUID, ${invoiceId}::UUID, ${plan.allocated})
    `;
  }

  const fee = merchantFee(receipt.feeRand, receipt.reported, charge.cents);
  const confirmed = await confirmCustomerPayment(companyId, paymentId, actorId, {
    postingAgent: GATEWAY_RECEIPT_AGENT,
  });
  await postGatewayFee({ ...receipt, feeRand: fee.feeRand }, actorId, String(bankAccount.id), paymentDate);
  const reviews = [
    ...charge.reviews,
    ...(plan.invoiceBlock ? [plan.invoiceBlock] : []),
    ...(plan.overpaid ? ['overpaid_unapplied'] : []),
    ...fee.reviews,
  ];
  if (reviews.length > 0) {
    await flagSettlementForReview(companyId, reference, reviews, {
      paymentId, invoiceId, invoiceStatus: plan.status, invoiceDeleted: plan.deleted,
      expectedCents: receipt.requestedCents, reportedCents: receipt.reported.amountCents,
      requestedAmountCents: receipt.reported.requestedAmountCents,
      reportedCurrency: receipt.reported.currency, bankedRand: amountRand, allocated: plan.allocated,
    });
  }

  log.info(
    'Recorded gateway invoice receipt',
    { reference, invoiceId, paymentId, allocated: plan.allocated, unallocated: amountRand - plan.allocated,
      journalEntryId: confirmed.glJournalEntryId },
    'accounting',
  );
  return { paymentId, journalEntryId: confirmed.glJournalEntryId };
}

/**
 * The date the gateway settled, or today when it did not say.
 *
 * A malformed `paid_at` would otherwise reach `fmtDate` as an Invalid Date and
 * make the insert raise 22007 on every redelivery — the same permanent-failure
 * shape a bad actor id used to cause.
 */
function settlementDate(receipt: GatewayInvoiceReceipt): string {
  if (receipt.paidAt) {
    const parsed = new Date(receipt.paidAt);
    if (!Number.isNaN(parsed.getTime())) return fmtDate(parsed);
    log.warn(
      'Gateway receipt carried an unparseable paid_at — dating it today',
      { reference: receipt.reference, paidAt: receipt.paidAt },
      'accounting',
    );
  }
  return fmtDate(new Date());
}

/**
 * A user who actually belongs to the paying company, for the NOT NULL
 * `created_by` a gateway callback has no user to fill.
 *
 * NOT `resolveUserUuid`: its fallback is `SELECT id FROM users … LIMIT 1` with
 * no company filter and no ORDER BY, so an invoice authored by an import string
 * would stamp the payment, its confirmation and its journal with whichever
 * person the heap yielded first — from any tenant. Fails closed instead: a
 * receipt attributed to a stranger is worse than a retryable 500, and K-035
 * makes the redelivery reprocess once a member exists.
 */
async function resolveCompanyActor(companyId: string, invoiceAuthor: string): Promise<string> {
  if (UUID_PATTERN.test(invoiceAuthor)) {
    const owned = await sql<{ user_id: string }>`
      SELECT cu.user_id FROM company_users cu
      WHERE cu.company_id = ${companyId}::UUID AND cu.user_id = ${invoiceAuthor}::TEXT
      LIMIT 1
    `;
    if (owned[0]) return invoiceAuthor;
  }
  // Deterministic, not heap order: the default member, then the oldest.
  const member = await sql<{ user_id: string }>`
    SELECT cu.user_id FROM company_users cu
    JOIN users u ON u.id::TEXT = cu.user_id
    WHERE cu.company_id = ${companyId}::UUID
      AND cu.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ORDER BY cu.is_default DESC NULLS LAST, cu.created_at ASC NULLS LAST, cu.user_id ASC
    LIMIT 1
  `;
  if (member[0]) return String(member[0].user_id);
  throw new Error(
    `Gateway receipt: company ${companyId} has no member to attribute the payment to`,
  );
}
