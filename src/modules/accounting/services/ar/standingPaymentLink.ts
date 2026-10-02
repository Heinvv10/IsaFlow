/**
 * The invoice's standing "Pay now" link: found, or minted once (R-177, R-179, R-180).
 *
 * A standing link (`charges_balance`) charges the live balance, is never spent and does not
 * expire. It is the link `customer_invoices.payment_url` names. Pay Now and enableOnlinePayment
 * both come here, so an invoice keeps one such link however often they are called; a link that
 * was cancelled, a link the invoice does not name, or an explicit-amount link is never handed
 * out as the standing one.
 *
 * Needs the caller's request transaction (`withCustomerInvoiceLock` refuses without one): the
 * invoice row is locked, for at most 5s, so two calls cannot both mint. The lock is NO KEY, so it
 * does not hold up a checkout or a receipt being recorded against the same invoice.
 */
import { sql } from '@/lib/neon';
import { documentInPopulation } from '@/modules/accounting/services/shared/documentPopulation';
import { withCustomerInvoiceLock } from './customerInvoiceLock';

/**
 * The public origin payment links are built on, or null when it is missing or points at this
 * machine: a link on localhost must never be stored on an invoice or emailed to a customer.
 */
export function portalAppUrl(): string | null {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  return !appUrl || /localhost|127\.0\.0\.1|\[::1\]/.test(appUrl) ? null : appUrl;
}

export type StandingLinkRefusal = 'invoice_not_found' | 'invoice_unapproved' | 'no_customer' | 'nothing_owed';

interface InvoiceRow {
  status: string;
  customer_id: string | null;
  owes: boolean | null;
}

export async function ensureStandingLink(
  companyId: string,
  invoiceId: string,
  appUrl: string,
): Promise<{ ok: true; token: string; paymentUrl: string } | { ok: false; reason: StandingLinkRefusal }> {
  // The balance is read in numeric: a NULL or negative amount_paid counts as nothing paid, and a
  // NaN balance owes nothing (NaN sorts above every number, so `> 0` alone would let it through).
  const rows = await withCustomerInvoiceLock('ensureStandingLink', 'This invoice', async () => (await sql`
    SELECT ci.status, COALESCE(ci.client_id, ci.customer_id) AS customer_id,
           (b.balance > 0 AND b.balance <> 'NaN') AS owes
    FROM customer_invoices ci
    CROSS JOIN LATERAL (SELECT ci.total_amount - GREATEST(ci.amount_paid, 0) AS balance) b
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND ci.status <> 'cancelled' AND ci.deleted_at IS NULL
    FOR NO KEY UPDATE OF ci
  `) as InvoiceRow[]);
  const invoice = rows[0];
  if (!invoice) return { ok: false, reason: 'invoice_not_found' };
  // R-180: a draft or an invoice awaiting approval is not yet a claim on the customer (R-082's rule).
  if (!documentInPopulation(invoice.status)) return { ok: false, reason: 'invoice_unapproved' };
  if (!invoice.customer_id) return { ok: false, reason: 'no_customer' };
  if (invoice.owes !== true) return { ok: false, reason: 'nothing_owed' };

  // A statement of its own, after the lock: a call that waited on the lock must see the link the
  // other one minted, and a subquery of the locking statement would still read its old snapshot.
  // The URL's tail is compared exactly, not with LIKE: a token is not a pattern.
  // No expiry test: the standing link the invoice names does not expire (see resolveLinkCharge).
  const existing = (await sql`
    SELECT l.token, ci.online_payment_enabled AS enabled, ci.payment_url
    FROM portal_payment_links l
    JOIN customer_invoices ci ON ci.id = l.invoice_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND l.status = 'active' AND l.charges_balance
      AND right(ci.payment_url, 12 + length(l.token)) = '/portal/pay/' || l.token
    LIMIT 1
  `) as { token: string; enabled: boolean | null; payment_url: string }[];
  if (existing[0]) {
    const paymentUrl = `${appUrl}/portal/pay/${existing[0].token}`;
    // A legacy row can name its link with the flag off, or on another origin (the old localhost
    // fallback); the invoice page shows and copies what is stored, so store what is handed out.
    if (existing[0].enabled !== true || existing[0].payment_url !== paymentUrl) {
      await sql`
        UPDATE customer_invoices SET online_payment_enabled = true, payment_url = ${paymentUrl}, updated_at = NOW()
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }
    return { ok: true, token: existing[0].token, paymentUrl };
  }

  // `amount` is only the balance at minting; a standing link charges the live balance.
  const minted = (await sql`
    INSERT INTO portal_payment_links (invoice_id, client_id, amount, charges_balance, expires_at)
    SELECT ci.id, ${invoice.customer_id}::UUID, ci.total_amount - GREATEST(ci.amount_paid, 0), true, NULL
    FROM customer_invoices ci
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    RETURNING token
  `) as { token: string }[];
  const token = minted[0]!.token;
  const paymentUrl = `${appUrl}/portal/pay/${token}`;
  await sql`
    UPDATE customer_invoices
    SET online_payment_enabled = true, payment_url = ${paymentUrl}, updated_at = NOW()
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
  return { ok: true, token, paymentUrl };
}

/**
 * Make sure no standing link on the invoice is live, and clear its `payment_url` and
 * `online_payment_enabled`, so the page stops offering one and the next Pay Now mints a fresh link.
 * Takes the same invoice lock as ensureStandingLink, so it cannot race a concurrent Pay Now.
 *
 * Cancels EVERY active `charges_balance` link on the invoice, not only the one `payment_url`
 * names: before R-177 each Pay Now click minted one (with a 30-day expiry) and they stay payable.
 * Explicit-amount links are left alone, and so is a checkout already open at Paystack: a payment
 * already started still settles as before.
 *
 * Succeeds with the number cancelled (0 when `payment_url` named a link that was already paid,
 * cancelled or fixed-amount: the dead URL is still cleared). Refuses only when there is nothing
 * to do: no active standing link and no `payment_url`. The refusal comes before the first write
 * (withAuth COMMITs a 4xx).
 */
export async function revokeStandingLink(
  companyId: string,
  invoiceId: string,
): Promise<{ ok: true; cancelled: number } | { ok: false; reason: 'invoice_not_found' | 'no_active_link' }> {
  const locked = await withCustomerInvoiceLock('revokeStandingLink', 'This invoice', async () => (await sql`
    SELECT ci.payment_url
    FROM customer_invoices ci
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID AND ci.deleted_at IS NULL
    FOR NO KEY UPDATE OF ci
  `) as { payment_url: string | null }[]);
  if (!locked[0]) return { ok: false, reason: 'invoice_not_found' };

  // A statement of its own, after the lock: a call that waited on the lock must see what the other
  // revoke committed, and a subquery of the locking statement would still read its old snapshot.
  const live = (await sql`
    SELECT 1 FROM portal_payment_links
    WHERE invoice_id = ${invoiceId}::UUID AND status = 'active' AND charges_balance
    LIMIT 1
  `) as unknown[];
  if (live.length === 0 && !locked[0].payment_url) return { ok: false, reason: 'no_active_link' };

  // One statement, scoped to this invoice (and its company through the invoice); the invoice is
  // cleared only after it has run, in the same transaction.
  const cancelled = (await sql`
    UPDATE portal_payment_links SET status = 'cancelled'
    WHERE invoice_id = ${invoiceId}::UUID AND status = 'active' AND charges_balance
      AND EXISTS (SELECT 1 FROM customer_invoices ci
                  WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID)
    RETURNING id
  `) as { id: string }[];
  await sql`
    UPDATE customer_invoices SET payment_url = NULL, online_payment_enabled = false, updated_at = NOW()
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
  return { ok: true, cancelled: cancelled.length };
}
