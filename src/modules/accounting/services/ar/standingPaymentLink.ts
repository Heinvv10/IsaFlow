/**
 * The invoice's standing "Pay now" link: found, or minted once (R-177, R-179, R-180).
 *
 * A standing link (`charges_balance`) charges the live balance, is never spent and does not
 * expire. It is the link `customer_invoices.payment_url` names. Pay Now and enableOnlinePayment
 * both come here, so an invoice keeps one such link however often they are called; a link that
 * was cancelled, or an explicit-amount link, is never handed out as the standing one.
 *
 * Runs in the caller's transaction. The invoice row is locked, so two calls cannot both mint.
 */
import { sql } from '@/lib/neon';

export type StandingLinkRefusal = 'invoice_not_found' | 'invoice_draft' | 'no_customer' | 'nothing_owed';

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
  const rows = (await sql`
    SELECT ci.status, COALESCE(ci.client_id, ci.customer_id) AS customer_id,
           (b.balance > 0 AND b.balance <> 'NaN') AS owes
    FROM customer_invoices ci
    CROSS JOIN LATERAL (SELECT ci.total_amount - GREATEST(ci.amount_paid, 0) AS balance) b
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND ci.status <> 'cancelled' AND ci.deleted_at IS NULL
    FOR UPDATE OF ci
  `) as InvoiceRow[];
  const invoice = rows[0];
  if (!invoice) return { ok: false, reason: 'invoice_not_found' };
  if (invoice.status === 'draft') return { ok: false, reason: 'invoice_draft' };
  if (!invoice.customer_id) return { ok: false, reason: 'no_customer' };
  if (invoice.owes !== true) return { ok: false, reason: 'nothing_owed' };

  // A statement of its own, after the lock: a call that waited on the lock must see the link the
  // other one minted, and a subquery of the locking statement would still read its old snapshot.
  const existing = (await sql`
    SELECT l.token
    FROM portal_payment_links l
    JOIN customer_invoices ci ON ci.id = l.invoice_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND l.status = 'active' AND l.charges_balance
      AND (l.expires_at IS NULL OR l.expires_at > NOW())
      AND ci.payment_url LIKE '%/portal/pay/' || l.token
    LIMIT 1
  `) as { token: string }[];
  if (existing[0]) return { ok: true, token: existing[0].token, paymentUrl: `${appUrl}/portal/pay/${existing[0].token}` };

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
