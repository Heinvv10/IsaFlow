/**
 * What a portal payment link may charge, and spending it once it is paid (R-167).
 *
 * Two kinds of link (Hein, 2026-09-30):
 * - the invoice's standing "Pay now" link (`charges_balance`, the one
 *   `customer_invoices.payment_url` names) charges the live balance and is never spent;
 * - an explicit-amount link (portal payment-link POST) charges its own amount, capped at the
 *   balance, and one payment spends it.
 *
 * The balance is `total_amount - GREATEST(amount_paid, 0)` in numeric, so a NULL or negative
 * amount_paid counts as nothing paid and never lifts a charge above the total. A NaN balance or
 * NaN link amount, a cancelled or soft-deleted invoice, or a charge of zero or less charges
 * nothing. Only a link whose status is exactly `active` is chargeable, and an invoice that is a
 * draft or awaiting approval is not payable through any link until it is approved (R-180).
 *
 * Expiry (R-179): a link expires at `expires_at`, except the standing link its invoice's
 * `payment_url` names. That one is emailed with the invoice and stays payable while the invoice
 * owes. Decided here, at read time, so no stored expiry has to be rewritten.
 *
 * The token is the only credential here (public routes), so every lookup starts from it.
 */
import { sql } from '@/lib/neon';
import { documentInPopulation } from '@/modules/accounting/services/shared/documentPopulation';

export type LinkChargeRefusal =
  | 'link_not_found' | 'link_not_active' | 'link_expired' | 'invoice_gone' | 'invoice_unapproved' | 'nothing_owed';

export interface LinkCharge {
  linkId: string;
  invoiceId: string;
  companyId: string;
  invoiceNumber: string;
  clientName: string;
  clientEmail: string | null;
  /** What the gateway is asked to take, in cents. Always > 0. */
  chargeCents: number;
}

interface Row {
  link_id: string;
  link_status: string | null;
  expired: boolean;
  invoice_id: string | null;
  invoice_status: string | null;
  company_id: string | null;
  invoice_number: string | null;
  client_name: string | null;
  client_email: string | null;
  charge_cents: string | null;
}

export async function resolveLinkCharge(
  token: string,
): Promise<{ ok: true; charge: LinkCharge } | { ok: false; reason: LinkChargeRefusal }> {
  const rows = (await sql`
    SELECT l.id AS link_id, l.status AS link_status,
           (COALESCE(l.expires_at < NOW(), false)
             AND NOT COALESCE(l.charges_balance AND right(ci.payment_url, 12 + length(l.token)) = '/portal/pay/' || l.token, false)) AS expired,
           ci.id AS invoice_id, ci.status AS invoice_status, ci.company_id, ci.invoice_number,
           COALESCE(c.name, 'Customer') AS client_name, c.email AS client_email,
           -- NaN sorts above every number, so LEAST would drop it silently; it charges nothing.
           CASE WHEN b.balance <> 'NaN' AND (l.charges_balance OR l.amount <> 'NaN')
                THEN ROUND(CASE WHEN l.charges_balance THEN b.balance ELSE LEAST(l.amount, b.balance) END * 100)::bigint
           END::text AS charge_cents
    FROM portal_payment_links l
    LEFT JOIN customer_invoices ci
      ON ci.id = l.invoice_id AND ci.status <> 'cancelled' AND ci.deleted_at IS NULL
    -- customers, not the clients view, so the payer is read with the invoice's own company_id: this
    -- runs on a public path with RLS bypassed, where the predicate is the isolation.
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    CROSS JOIN LATERAL (SELECT ci.total_amount - GREATEST(ci.amount_paid, 0) AS balance) b
    WHERE l.token = ${token}
    LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) return { ok: false, reason: 'link_not_found' };
  if (row.link_status !== 'active') return { ok: false, reason: 'link_not_active' };
  if (row.expired) return { ok: false, reason: 'link_expired' };
  if (!row.invoice_id || !row.company_id) return { ok: false, reason: 'invoice_gone' };
  if (!documentInPopulation(row.invoice_status)) return { ok: false, reason: 'invoice_unapproved' };
  const chargeCents = row.charge_cents === null ? 0 : Number(row.charge_cents);
  if (!(chargeCents > 0)) return { ok: false, reason: 'nothing_owed' };
  return {
    ok: true,
    charge: {
      linkId: row.link_id,
      invoiceId: row.invoice_id,
      companyId: row.company_id,
      invoiceNumber: String(row.invoice_number),
      clientName: String(row.client_name),
      clientEmail: row.client_email,
      chargeCents,
    },
  };
}

/** Serialises checkouts from one link for the rest of the caller's transaction. */
export async function lockPaymentLink(token: string): Promise<void> {
  await sql`SELECT 1 FROM portal_payment_links WHERE token = ${token} FOR UPDATE`;
}

/** How long a started checkout is handed out again instead of starting a second one. */
export const CHECKOUT_REUSE_MINUTES = 30;
/** A checkout recorded but not yet given its URL is "starting" for this long, then abandoned. */
export const CHECKOUT_STARTING_SECONDS = 60;

export type ExistingCheckout =
  | { kind: 'reuse'; checkoutUrl: string; reference: string }
  | { kind: 'starting' }
  | { kind: 'none' };

/**
 * The latest pending checkout from this link for the same amount, in the reuse window. A double
 * click or a back-and-retry gets it again instead of a second charge. One recorded in the last
 * minute that has no URL yet is still being started, so the caller must wait, not start another.
 * A different amount (the balance moved), an older one, or one abandoned while starting: none.
 * Checkouts abandoned while starting (no URL after the starting window: the gateway call or the
 * URL write never finished) are marked failed here, under the link lock, so none stays `pending`.
 */
export async function existingCheckout(charge: LinkCharge): Promise<ExistingCheckout> {
  await sql`
    UPDATE paystack_payment_requests
    SET status = 'failed', failure_reason = 'abandoned while starting', updated_at = NOW()
    WHERE company_id = ${charge.companyId}::UUID AND portal_payment_link_id = ${charge.linkId}::UUID
      AND status = 'pending' AND authorization_url IS NULL
      AND created_at <= NOW() - make_interval(secs => ${CHECKOUT_STARTING_SECONDS})
  `;
  // Any checkout from this link still waiting for its URL, whatever its amount: the balance can
  // move while one is at the gateway, and a second must not start beside it.
  const starting = (await sql`
    SELECT 1 FROM paystack_payment_requests
    WHERE company_id = ${charge.companyId}::UUID AND portal_payment_link_id = ${charge.linkId}::UUID
      AND status = 'pending' AND authorization_url IS NULL
    LIMIT 1
  `) as unknown[];
  if (starting.length > 0) return { kind: 'starting' };

  const rows = (await sql`
    SELECT authorization_url, paystack_reference
    FROM paystack_payment_requests
    WHERE company_id = ${charge.companyId}::UUID AND portal_payment_link_id = ${charge.linkId}::UUID
      AND status = 'pending' AND amount_cents = ${charge.chargeCents} AND authorization_url IS NOT NULL
      AND created_at > NOW() - make_interval(mins => ${CHECKOUT_REUSE_MINUTES})
    ORDER BY created_at DESC
    LIMIT 1
  `) as { authorization_url: string; paystack_reference: string }[];
  const row = rows[0];
  return row ? { kind: 'reuse', checkoutUrl: row.authorization_url, reference: row.paystack_reference } : { kind: 'none' };
}

/** Record a checkout before the gateway is called, so a second click finds it (see create). */
export async function recordStartingCheckout(charge: LinkCharge, reference: string, payerEmail: string): Promise<void> {
  await sql`
    INSERT INTO paystack_payment_requests (
      company_id, purpose, customer_invoice_id, paystack_reference,
      amount_cents, currency, status, payer_name, payer_email, portal_payment_link_id
    ) VALUES (
      ${charge.companyId}::UUID, 'customer_invoice', ${charge.invoiceId}::UUID, ${reference},
      ${charge.chargeCents}, 'ZAR', 'pending', ${charge.clientName}, ${payerEmail}, ${charge.linkId}::UUID
    )
  `;
}

/**
 * The gateway accepted the checkout: store where the customer pays it. False when the recorded
 * checkout is no longer pending (a stall past the starting window let a later click sweep it),
 * in which case the URL must not be handed out.
 */
export async function checkoutStarted(companyId: string, reference: string, accessCode: string, url: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE paystack_payment_requests
    SET paystack_access_code = ${accessCode}, authorization_url = ${url}, updated_at = NOW()
    WHERE company_id = ${companyId}::UUID AND paystack_reference = ${reference} AND status = 'pending'
    RETURNING id
  `) as { id: string }[];
  return rows.length === 1;
}

/** The gateway refused or timed out: the recorded checkout can never be paid. */
export async function checkoutFailed(companyId: string, reference: string, reason: string): Promise<void> {
  await sql`
    UPDATE paystack_payment_requests
    SET status = 'failed', failure_reason = ${reason}, updated_at = NOW()
    WHERE company_id = ${companyId}::UUID AND paystack_reference = ${reference} AND status = 'pending'
  `;
}

/**
 * Spend the explicit-amount link a completed Paystack request came from, so it cannot be paid
 * again. Idempotent: only an `active` link moves, and only the link of the request's own invoice.
 * A standing link (`charges_balance`), a request with no link (every request made before migration 717, and every non-portal purpose), or a
 * request that is not completed touches nothing. Runs inside the settlement transaction.
 */
export async function spendPaymentLinkOfRequest(companyId: string, reference: string): Promise<void> {
  await sql`
    UPDATE portal_payment_links l
    SET status = 'paid', paid_at = COALESCE(l.paid_at, NOW()), payment_reference = ${reference}
    FROM paystack_payment_requests pr
    WHERE pr.paystack_reference = ${reference} AND pr.company_id = ${companyId}::UUID
      AND pr.status = 'completed' AND l.id = pr.portal_payment_link_id
      AND l.invoice_id = pr.customer_invoice_id
      AND l.status = 'active' AND NOT l.charges_balance
  `;
}
