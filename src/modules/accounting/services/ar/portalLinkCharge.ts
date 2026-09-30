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
 * nothing. Only a link whose status is exactly `active` is chargeable.
 *
 * The token is the only credential here (public routes), so every lookup starts from it.
 */
import { sql } from '@/lib/neon';

export type LinkChargeRefusal = 'link_not_found' | 'link_not_active' | 'link_expired' | 'invoice_gone' | 'nothing_owed';

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
           COALESCE(l.expires_at < NOW(), false) AS expired,
           ci.id AS invoice_id, ci.company_id, ci.invoice_number,
           COALESCE(c.name, 'Customer') AS client_name, c.email AS client_email,
           -- NaN sorts above every number, so LEAST would drop it silently; it charges nothing.
           CASE WHEN b.balance <> 'NaN' AND (l.charges_balance OR l.amount <> 'NaN')
                THEN ROUND(CASE WHEN l.charges_balance THEN b.balance ELSE LEAST(l.amount, b.balance) END * 100)::bigint
           END::text AS charge_cents
    FROM portal_payment_links l
    LEFT JOIN customer_invoices ci
      ON ci.id = l.invoice_id AND ci.status <> 'cancelled' AND ci.deleted_at IS NULL
    LEFT JOIN clients c ON c.id = COALESCE(ci.client_id, ci.customer_id)
    CROSS JOIN LATERAL (SELECT ci.total_amount - GREATEST(ci.amount_paid, 0) AS balance) b
    WHERE l.token = ${token}
    LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) return { ok: false, reason: 'link_not_found' };
  if (row.link_status !== 'active') return { ok: false, reason: 'link_not_active' };
  if (row.expired) return { ok: false, reason: 'link_expired' };
  if (!row.invoice_id || !row.company_id) return { ok: false, reason: 'invoice_gone' };
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

/**
 * A checkout already started from this link for the same amount, recently: returned instead of a
 * new one, so a customer who clicks Pay twice gets one charge rather than two. A different amount
 * (the balance moved) or an older one starts afresh.
 */
export async function findReusableCheckout(
  charge: LinkCharge,
): Promise<{ checkoutUrl: string; reference: string } | null> {
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
  return row ? { checkoutUrl: row.authorization_url, reference: row.paystack_reference } : null;
}

/**
 * Spend the explicit-amount link a completed Paystack request came from, so it cannot be paid
 * again. Idempotent: only an `active` link moves. A standing link (`charges_balance`), a request
 * with no link (every request made before migration 717, and every non-portal purpose), or a
 * request that is not completed touches nothing. Runs inside the settlement transaction.
 */
export async function spendPaymentLinkOfRequest(companyId: string, reference: string): Promise<void> {
  await sql`
    UPDATE portal_payment_links l
    SET status = 'paid', paid_at = COALESCE(l.paid_at, NOW()), payment_reference = ${reference}
    FROM paystack_payment_requests pr
    WHERE pr.paystack_reference = ${reference} AND pr.company_id = ${companyId}::UUID
      AND pr.status = 'completed' AND l.id = pr.portal_payment_link_id
      AND l.status = 'active' AND NOT l.charges_balance
  `;
}
