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
  // No expiry test: the standing link the invoice names does not expire (see resolveLinkCharge).
  const existing = (await sql`
    SELECT l.token, ci.online_payment_enabled AS enabled
    FROM portal_payment_links l
    JOIN customer_invoices ci ON ci.id = l.invoice_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND l.status = 'active' AND l.charges_balance
      AND ci.payment_url LIKE '%/portal/pay/' || l.token
    LIMIT 1
  `) as { token: string; enabled: boolean | null }[];
  if (existing[0]) {
    // A legacy row can name its link with the flag off; the invoice page shows the link by the flag.
    if (existing[0].enabled !== true) {
      await sql`
        UPDATE customer_invoices SET online_payment_enabled = true, updated_at = NOW()
        WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }
    return { ok: true, token: existing[0].token, paymentUrl: `${appUrl}/portal/pay/${existing[0].token}` };
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
