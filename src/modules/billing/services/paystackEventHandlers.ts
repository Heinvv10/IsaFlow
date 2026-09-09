/**
 * Paystack webhook event handlers.
 *
 * Split out of `pages/api/webhooks/paystack.ts` (which carries the signature
 * check, the idempotency record and the transaction) to keep both files inside
 * the 300-line limit. Every `sql` call below joins the caller's transaction via
 * ALS, so a throw here rolls the whole event back.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { recordGatewayInvoiceReceipt } from '@/modules/accounting/services/ar/gatewayInvoiceReceiptService';
import { completeBundlePurchase, failBundlePurchase } from './flowWalletService';

export interface PaystackWebhookEvent {
  event: string;
  data: {
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
    channel?: string;
    paid_at?: string;
    /** Gateway fee in cents, deducted from the settlement. */
    fees?: number;
    gateway_response?: string;
    id?: number;
    customer?: {
      email?: string;
      customer_code?: string;
    };
    authorization?: {
      authorization_code?: string;
      last4?: string;
      brand?: string;
      exp_month?: string;
      exp_year?: string;
      bank?: string;
      reusable?: boolean;
    };
    plan?: {
      plan_code?: string;
    };
    subscription_code?: string;
    email_token?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export async function processEvent(
  eventType: string,
  event: PaystackWebhookEvent,
): Promise<void> {
  const data = event.data ?? {};
  const reference = data.reference;

  if (eventType === 'charge.success') {
    if (!reference) return;
    await handleChargeSuccess(reference, event);
    return;
  }

  if (
    eventType === 'charge.failed' ||
    eventType === 'invoice.payment_failed'
  ) {
    if (reference) await handleChargeFailed(reference, eventType);
    return;
  }

  if (eventType === 'subscription.disable') {
    const subCode = (data.subscription_code as string | undefined) ?? null;
    if (subCode) await handleSubscriptionDisabled(subCode);
    return;
  }

  // subscription.create / invoice.create / invoice.update — informational.
  log.info('Paystack event recorded (no-op handler)', { eventType }, 'PaystackWebhook');
}

/**
 * The mandate a successful authorisation belongs to, or null if there is none.
 * Migration 651 records the link on the payment request; rows written before it
 * have none (create.ts passed the id only in Paystack metadata) and fall back
 * to the company's newest pending paystack mandate. Either way: at most ONE row.
 */
async function resolveAuthorisedMandateId(
  companyId: string,
  linkedMandateId: string | null,
): Promise<string | null> {
  if (linkedMandateId) {
    const rows = await sql<{ id: string }>`
      SELECT id FROM subscription_mandates
      WHERE id = ${linkedMandateId}
        AND company_id = ${companyId}
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }
  const rows = await sql<{ id: string }>`
    SELECT id FROM subscription_mandates
    WHERE company_id = ${companyId}
      AND gateway = 'paystack'
      AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

async function handleChargeSuccess(
  reference: string,
  event: PaystackWebhookEvent,
): Promise<void> {
  const auth = event.data.authorization ?? {};
  const customer = event.data.customer ?? {};

  const prRows = await sql<{
    id: string;
    company_id: string;
    purpose: string;
    customer_invoice_id: string | null;
    flow_purchase_id: string | null;
    subscription_charge_id: string | null;
    mandate_id: string | null;
    amount_cents: string;
    status: string;
  }>`
    UPDATE paystack_payment_requests
    SET status = 'completed',
        completed_at = COALESCE(completed_at, now()),
        paystack_transaction_id = ${event.data.id ?? null},
        paystack_authorization_code = COALESCE(${auth.authorization_code ?? null}, paystack_authorization_code),
        paystack_customer_code = COALESCE(${customer.customer_code ?? null}, paystack_customer_code),
        channel = COALESCE(${event.data.channel ?? null}, channel)
    WHERE paystack_reference = ${reference}
      AND status <> 'completed'
    RETURNING id, company_id, purpose, customer_invoice_id, flow_purchase_id, subscription_charge_id, mandate_id, amount_cents, status
  `;
  const pr = prRows[0];
  if (!pr) {
    // The guarded UPDATE matched nothing because the request is ALREADY
    // completed — normally because the portal return page's verify route got
    // there first. That route banks the receipt but carries no fee, and this
    // delivery does, so the settlement still needs the fee leg. Re-read the row
    // and let recordGatewayInvoiceReceipt decide: it is idempotent on the
    // reference and will post only what is missing.
    const settled = await sql<{
      id: string;
      company_id: string;
      purpose: string;
      customer_invoice_id: string | null;
      amount_cents: string;
    }>`
      SELECT id, company_id, purpose, customer_invoice_id, amount_cents
      FROM paystack_payment_requests
      WHERE paystack_reference = ${reference} AND status = 'completed'
      LIMIT 1
    `;
    const done = settled[0];
    if (done && done.purpose === 'customer_invoice' && done.customer_invoice_id) {
      await recordGatewayInvoiceReceipt({
        companyId: done.company_id,
        invoiceId: done.customer_invoice_id,
        amountRand: Number(done.amount_cents) / 100,
        reference,
        paidAt: event.data.paid_at ?? null,
        feeRand: typeof event.data.fees === 'number' ? event.data.fees / 100 : null,
      });
      return;
    }
    log.info(
      'charge.success — no matching payment request (possible duplicate or out-of-band)',
      { reference },
      'PaystackWebhook',
    );
    return;
  }

  if (pr.purpose === 'customer_invoice' && pr.customer_invoice_id) {
    // Records the receipt through the canonical AR path — a customer_payments
    // row plus DR Bank / CR Receivable — instead of bumping amount_paid alone.
    await recordGatewayInvoiceReceipt({
      companyId: pr.company_id,
      invoiceId: pr.customer_invoice_id,
      amountRand: Number(pr.amount_cents) / 100,
      reference,
      paidAt: event.data.paid_at ?? null,
      feeRand: typeof event.data.fees === 'number' ? event.data.fees / 100 : null,
    });
    return;
  }

  if (pr.purpose === 'flow_bundle' && pr.flow_purchase_id) {
    await completeBundlePurchase(pr.flow_purchase_id);
    log.info(
      'flow bundle credited via Paystack webhook',
      { purchaseId: pr.flow_purchase_id, companyId: pr.company_id },
      'PaystackWebhook',
    );
    return;
  }

  if (pr.purpose === 'authorization' && auth.authorization_code) {
    // Auth capture — promote the authorization onto the ONE mandate this
    // checkout was started for. The predicate used to be every mandate on the
    // company with status IN ('pending','active'), which raises 23505 on
    // ux_sub_mandates_company_active once an abandoned-then-retried checkout
    // has left a second pending row behind. That throw rolls the event back,
    // the webhook answers 500, and every redelivery hits the same constraint.
    const mandateId = await resolveAuthorisedMandateId(pr.company_id, pr.mandate_id);
    if (!mandateId) {
      log.warn(
        'charge.success authorisation has no mandate row to activate',
        { reference, companyId: pr.company_id },
        'PaystackWebhook',
      );
      return;
    }
    await sql`
      UPDATE subscription_mandates
      SET status = 'active',
          gateway = 'paystack',
          paystack_authorization_code = ${auth.authorization_code},
          paystack_customer_code = ${customer.customer_code ?? null},
          card_last4 = ${auth.last4 ?? null},
          card_brand = ${auth.brand ?? null},
          card_exp_month = ${auth.exp_month ?? null},
          card_exp_year = ${auth.exp_year ?? null},
          bank_name = COALESCE(${auth.bank ?? null}, bank_name),
          authorised_at = COALESCE(authorised_at, now()),
          updated_at = now()
      WHERE id = ${mandateId}
        AND company_id = ${pr.company_id}
    `;
    return;
  }

  if (pr.purpose === 'subscription_charge' && pr.subscription_charge_id) {
    await sql`
      UPDATE subscription_charges
      SET status = 'settled',
          settled_at = COALESCE(settled_at, now()),
          updated_at = now()
      WHERE id = ${pr.subscription_charge_id} AND company_id = ${pr.company_id}
    `;
  }
}

async function handleChargeFailed(reference: string, reason: string): Promise<void> {
  const prRows = await sql<{
    id: string;
    purpose: string;
    flow_purchase_id: string | null;
    subscription_charge_id: string | null;
  }>`
    UPDATE paystack_payment_requests
    SET status = 'failed',
        failure_reason = ${reason}
    WHERE paystack_reference = ${reference}
      AND status NOT IN ('completed','failed')
    RETURNING id, purpose, flow_purchase_id, subscription_charge_id
  `;
  const pr = prRows[0];
  if (!pr) return;

  if (pr.purpose === 'flow_bundle' && pr.flow_purchase_id) {
    await failBundlePurchase(pr.flow_purchase_id, reason);
  }
  if (pr.purpose === 'subscription_charge' && pr.subscription_charge_id) {
    await sql`
      UPDATE subscription_charges
      SET status = 'failed',
          failure_reason = ${reason},
          attempt_count = attempt_count + 1,
          last_attempt_at = now(),
          updated_at = now()
      WHERE id = ${pr.subscription_charge_id}
    `;
  }
}

async function handleSubscriptionDisabled(subscriptionCode: string): Promise<void> {
  await sql`
    UPDATE subscription_mandates
    SET status = 'revoked',
        revoked_at = COALESCE(revoked_at, now()),
        revoked_reason = 'paystack_subscription_disabled',
        updated_at = now()
    WHERE paystack_subscription_code = ${subscriptionCode}
      AND status NOT IN ('revoked','expired')
  `;
}
