/**
 * Payment Gateway Portal Service
 * Handles portal payment link generation and online payment enablement.
 * Re-exported from paymentGatewayService for backward compatibility.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

/**
 * Enable online payment for an invoice and generate a payment URL.
 * Creates a portal payment link token for public access. It is the invoice's
 * standing link (`charges_balance`): it charges the live balance and a payment
 * does not spend it (R-167).
 * Null (nothing written) when the invoice is not this company's, is cancelled or
 * soft-deleted, or has no balance due.
 */
export async function enableOnlinePayment(companyId: string, invoiceId: string): Promise<string | null> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3101';

  const linkRows = (await sql`
    INSERT INTO portal_payment_links (invoice_id, client_id, amount, charges_balance)
    SELECT ci.id, COALESCE(ci.client_id, ci.customer_id), ci.total_amount - COALESCE(ci.amount_paid, 0), true
    FROM customer_invoices ci
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
      AND ci.status != 'cancelled' AND ci.deleted_at IS NULL
      AND ci.total_amount - COALESCE(ci.amount_paid, 0) > 0
    RETURNING token
  `) as Record<string, unknown>[];

  if (!linkRows[0]) return null;

  const token = linkRows[0].token as string;
  const paymentUrl = `${appUrl}/portal/pay/${token}`;

  await sql`
    UPDATE customer_invoices
    SET online_payment_enabled = true, payment_url = ${paymentUrl}, updated_at = NOW()
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Online payment enabled', { invoiceId, paymentUrl }, 'PaymentGateway');
  return paymentUrl;
}
