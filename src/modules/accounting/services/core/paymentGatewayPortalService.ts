/**
 * Payment Gateway Portal Service
 * Handles portal payment link generation and online payment enablement.
 * Re-exported from paymentGatewayService for backward compatibility.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

/**
 * Enable online payment for an invoice and generate a payment URL.
 * Creates a portal payment link token for public access.
 */
export async function enableOnlinePayment(companyId: string, invoiceId: string): Promise<string> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3101';

  const linkRows = (await sql`
    INSERT INTO portal_payment_links (invoice_id, client_id, amount)
    SELECT ci.id, ci.client_id, ci.total_amount - COALESCE(ci.amount_paid, 0)
    FROM customer_invoices ci
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    RETURNING token
  `) as Record<string, unknown>[];

  if (!linkRows[0]) throw new Error('Invoice not found or no balance due');

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
