/**
 * Payment Gateway Service — PayFast integration
 * Handles payment form generation, transaction tracking, and status queries.
 * ITN logic: paymentGatewayItnService.ts
 * Portal link logic: paymentGatewayPortalService.ts
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getConfig, getPayFastUrl, generateSignature } from './paymentGatewayCore';

type Row = Record<string, unknown>;

// ── Re-exports for backward compatibility ────────────────────────────────────
export { handleITN } from './paymentGatewayItnService';
export { enableOnlinePayment } from './paymentGatewayPortalService';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PayFastFormData {
  paymentUrl: string;
  fields: Record<string, string>;
  transactionId: string;
}

interface PaymentTransaction {
  id: string;
  companyId: string;
  invoiceId: string | null;
  gateway: string;
  gatewayRef: string | null;
  amount: number;
  currency: string;
  status: string;
  customerEmail: string | null;
  customerName: string | null;
  paymentMethod: string | null;
  metadata: Record<string, unknown>;
  errorMessage: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Mapper ───────────────────────────────────────────────────────────────────

function mapTransaction(r: Row): PaymentTransaction {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    invoiceId: r.invoice_id != null ? String(r.invoice_id) : null,
    gateway: String(r.gateway),
    gatewayRef: r.gateway_ref != null ? String(r.gateway_ref) : null,
    amount: Number(r.amount),
    currency: String(r.currency),
    status: String(r.status),
    customerEmail: r.customer_email != null ? String(r.customer_email) : null,
    customerName: r.customer_name != null ? String(r.customer_name) : null,
    paymentMethod: r.payment_method != null ? String(r.payment_method) : null,
    metadata: (r.metadata as Record<string, unknown>) || {},
    errorMessage: r.error_message != null ? String(r.error_message) : null,
    paidAt: r.paid_at != null ? String(r.paid_at) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// ── Public Functions ─────────────────────────────────────────────────────────

/**
 * Generate PayFast payment form data for an invoice.
 */
export async function generatePayFastForm(
  companyId: string,
  invoiceId: string,
  returnUrl: string,
  cancelUrl: string,
  notifyUrl: string,
): Promise<PayFastFormData> {
  const config = getConfig();
  if (!config.merchantId || !config.merchantKey) {
    throw new Error('PayFast merchant credentials not configured');
  }

  const invoices = (await sql`
    SELECT ci.id, ci.invoice_number, ci.total_amount, ci.amount_paid,
           ci.client_name, ci.status,
           c.email AS client_email
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = ci.client_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
  `) as Row[];

  if (!invoices[0]) throw new Error('Invoice not found');

  const invRow = invoices[0];
  const inv = {
    invoice_number: String(invRow.invoice_number ?? ''),
    total_amount: Number(invRow.total_amount),
    amount_paid: Number(invRow.amount_paid ?? 0),
    client_name: invRow.client_name != null ? String(invRow.client_name) : null,
    client_email: invRow.client_email != null ? String(invRow.client_email) : null,
  };
  const balance = inv.total_amount - inv.amount_paid;
  if (balance <= 0) throw new Error('Invoice is already fully paid');

  const txRows = (await sql`
    INSERT INTO payment_transactions (
      company_id, invoice_id, gateway, amount, currency,
      customer_email, customer_name, status
    ) VALUES (
      ${companyId}::UUID, ${invoiceId}::UUID, 'payfast', ${balance}, 'ZAR',
      ${inv.client_email || ''}, ${inv.client_name || ''}, 'pending'
    )
    RETURNING id
  `) as Row[];

  const transactionId = String(txRows[0]!.id);

  const fields: Record<string, string> = {
    merchant_id: config.merchantId,
    merchant_key: config.merchantKey,
    return_url: returnUrl,
    cancel_url: cancelUrl,
    notify_url: notifyUrl,
    m_payment_id: transactionId,
    amount: balance.toFixed(2),
    item_name: `Invoice ${inv.invoice_number}`.slice(0, 100),
    item_description: `Payment for invoice ${inv.invoice_number}`.slice(0, 255),
  };

  if (inv.client_email) fields.email_address = inv.client_email;

  if (inv.client_name) {
    const nameParts = inv.client_name.split(' ');
    fields.name_first = (nameParts[0] || '').slice(0, 100);
    fields.name_last = (nameParts.slice(1).join(' ') || '').slice(0, 100);
  }

  fields.signature = generateSignature(fields, config.passphrase);

  log.info('PayFast form generated', { transactionId, invoiceId, amount: balance }, 'PaymentGateway');

  return { paymentUrl: getPayFastUrl(), fields, transactionId };
}

/**
 * Get payment transaction details.
 */
export async function getPaymentStatus(companyId: string, transactionId: string) {
  const rows = (await sql`
    SELECT * FROM payment_transactions
    WHERE id = ${transactionId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  if (!rows[0]) return null;
  return mapTransaction(rows[0]);
}

/**
 * List all payment attempts for an invoice.
 */
export async function getInvoicePayments(companyId: string, invoiceId: string) {
  const rows = (await sql`
    SELECT * FROM payment_transactions
    WHERE invoice_id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY created_at DESC
  `) as Row[];

  return rows.map(mapTransaction);
}
