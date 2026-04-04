/**
 * Payment Gateway Service — PayFast integration
 * Handles payment form generation, ITN validation, and transaction tracking.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import crypto from 'crypto';
type Row = any;


// ── Config ──────────────────────────────────────────────────────────────────

const PAYFAST_SANDBOX_URL = 'https://sandbox.payfast.co.za/eng/process';
const PAYFAST_LIVE_URL = 'https://www.payfast.co.za/eng/process';

// PayFast valid IP ranges (production)
const PAYFAST_IP_RANGES = [
  '197.97.145.144/28',
  '41.74.179.192/27',
  '196.12.62.128/27',
];

// Sandbox allows any IP, but we still check in production
const PAYFAST_SANDBOX_IPS = ['127.0.0.1', '::1'];

function getConfig() {
  return {
    merchantId: process.env.PAYFAST_MERCHANT_ID || '',
    merchantKey: process.env.PAYFAST_MERCHANT_KEY || '',
    passphrase: process.env.PAYFAST_PASSPHRASE || '',
    isSandbox: process.env.PAYFAST_SANDBOX === 'true',
  };
}

function getPayFastUrl(): string {
  return getConfig().isSandbox ? PAYFAST_SANDBOX_URL : PAYFAST_LIVE_URL;
}

// ── Signature Generation ────────────────────────────────────────────────────

function generateSignature(data: Record<string, string>, passphrase: string): string {
  // Sort keys alphabetically, exclude blank values and 'signature' key
  const sortedKeys = Object.keys(data)
    .filter(k => k !== 'signature' && data[k] !== '' && data[k] !== undefined && data[k] !== null)
    .sort();

  const queryString = sortedKeys
    .map(k => `${k}=${encodeURIComponent(data[k]!).replace(/%20/g, '+')}`)
    .join('&');

  const toHash = passphrase ? `${queryString}&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}` : queryString;

  return crypto.createHash('md5').update(toHash).digest('hex');
}

// ── IP Validation ───────────────────────────────────────────────────────────

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!range || !bitsStr) return false;
  const bits = parseInt(bitsStr, 10);

  const ipParts = ip.split('.').map(Number);
  const rangeParts = range.split('.').map(Number);

  const ipNum = ((ipParts[0]! << 24) | (ipParts[1]! << 16) | (ipParts[2]! << 8) | ipParts[3]!) >>> 0;
  const rangeNum = ((rangeParts[0]! << 24) | (rangeParts[1]! << 16) | (rangeParts[2]! << 8) | rangeParts[3]!) >>> 0;
  const mask = (~0 << (32 - bits)) >>> 0;

  return (ipNum & mask) === (rangeNum & mask);
}

function isPayFastIp(ip: string): boolean {
  const config = getConfig();
  if (config.isSandbox) return true; // Sandbox mode: accept any IP

  // Strip IPv6 prefix
  const cleanIp = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  for (const cidr of PAYFAST_IP_RANGES) {
    if (ipInCidr(cleanIp, cidr)) return true;
  }
  return PAYFAST_SANDBOX_IPS.includes(cleanIp);
}

// ── Public Functions ────────────────────────────────────────────────────────

export interface PayFastFormData {
  paymentUrl: string;
  fields: Record<string, string>;
  transactionId: string;
}

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

  // Look up invoice details
  const invoices = (await sql`
    SELECT ci.id, ci.invoice_number, ci.total_amount, ci.amount_paid,
           ci.client_name, ci.status,
           c.email AS client_email
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = ci.client_id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
  `) as Row[];

  if (!invoices[0]) throw new Error('Invoice not found');

  const inv = invoices[0];
  const balance = Number(inv.total_amount) - Number(inv.amount_paid || 0);
  if (balance <= 0) throw new Error('Invoice is already fully paid');

  // Create payment transaction record
  const txRows = (await sql`
    INSERT INTO payment_transactions (company_id, invoice_id, gateway, amount, currency, customer_email, customer_name, status)
    VALUES (${companyId}::UUID, ${invoiceId}::UUID, 'payfast', ${balance}, 'ZAR', ${inv.client_email || ''}, ${inv.client_name || ''}, 'pending')
    RETURNING id
  `) as Row[];

  const transactionId = txRows[0].id as string;

  // Build PayFast form fields
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

  // Add customer email if available
  if (inv.client_email) {
    fields.email_address = inv.client_email;
  }

  // Add customer name if available
  if (inv.client_name) {
    const nameParts = (inv.client_name as string).split(' ');
    fields.name_first = (nameParts[0] || '').slice(0, 100);
    fields.name_last = (nameParts.slice(1).join(' ') || '').slice(0, 100);
  }

  // Generate signature
  fields.signature = generateSignature(fields, config.passphrase);

  log.info('PayFast form generated', { transactionId, invoiceId, amount: balance }, 'PaymentGateway');

  return {
    paymentUrl: getPayFastUrl(),
    fields,
    transactionId,
  };
}

/**
 * Handle PayFast ITN (Instant Transaction Notification).
 * Validates the notification and updates payment status.
 */
export async function handleITN(
  body: Record<string, string>,
  sourceIp: string,
): Promise<{ valid: boolean; transactionId: string | null }> {
  const config = getConfig();

  // 1. Verify source IP
  if (!isPayFastIp(sourceIp)) {
    log.error('ITN rejected: invalid source IP', { sourceIp }, 'PaymentGateway');
    return { valid: false, transactionId: null };
  }

  // 2. Verify signature
  const receivedSignature = body.signature;
  if (!receivedSignature) {
    log.error('ITN rejected: no signature', {}, 'PaymentGateway');
    return { valid: false, transactionId: null };
  }

  const dataForSig = { ...body };
  delete dataForSig.signature;
  const expectedSignature = generateSignature(dataForSig, config.passphrase);

  if (receivedSignature !== expectedSignature) {
    log.error('ITN rejected: signature mismatch', { received: receivedSignature, expected: expectedSignature }, 'PaymentGateway');
    return { valid: false, transactionId: null };
  }

  const transactionId = body.m_payment_id || null;
  if (!transactionId) {
    log.error('ITN rejected: no m_payment_id', {}, 'PaymentGateway');
    return { valid: false, transactionId: null };
  }

  // 3. Look up the transaction
  const txRows = (await sql`
    SELECT id, company_id, invoice_id, amount, status
    FROM payment_transactions WHERE id = ${transactionId}::UUID
  `) as Row[];

  if (!txRows[0]) {
    log.error('ITN rejected: transaction not found', { transactionId }, 'PaymentGateway');
    return { valid: false, transactionId };
  }

  const tx = txRows[0];

  // 4. Verify amount matches
  const itnAmount = parseFloat(body.amount_gross || '0');
  const expectedAmount = Number(tx.amount);
  if (Math.abs(itnAmount - expectedAmount) > 0.01) {
    log.error('ITN rejected: amount mismatch', { expected: expectedAmount, received: itnAmount }, 'PaymentGateway');
    await sql`
      UPDATE payment_transactions SET status = 'failed', error_message = 'Amount mismatch', updated_at = NOW()
      WHERE id = ${transactionId}::UUID
    `;
    return { valid: false, transactionId };
  }

  // 5. Map PayFast status to our status
  const pfStatus = (body.payment_status || '').toUpperCase();
  let newStatus: string;
  switch (pfStatus) {
    case 'COMPLETE':
      newStatus = 'completed';
      break;
    case 'FAILED':
      newStatus = 'failed';
      break;
    case 'PENDING':
      newStatus = 'processing';
      break;
    case 'CANCELLED':
      newStatus = 'cancelled';
      break;
    default:
      newStatus = 'processing';
  }

  // 6. Update transaction
  await sql`
    UPDATE payment_transactions
    SET status = ${newStatus},
        gateway_ref = ${body.pf_payment_id || ''},
        payment_method = ${body.payment_method || ''},
        paid_at = ${newStatus === 'completed' ? new Date().toISOString() : null},
        metadata = ${JSON.stringify(body)}::JSONB,
        updated_at = NOW()
    WHERE id = ${transactionId}::UUID
  `;

  // 7. If completed, update the invoice
  if (newStatus === 'completed' && tx.invoice_id) {
    await sql`
      UPDATE customer_invoices
      SET amount_paid = COALESCE(amount_paid, 0) + ${itnAmount},
          status = CASE
            WHEN COALESCE(amount_paid, 0) + ${itnAmount} >= total_amount THEN 'paid'
            ELSE 'partially_paid'
          END,
          updated_at = NOW()
      WHERE id = ${tx.invoice_id}::UUID AND company_id = ${tx.company_id}::UUID
    `;

    log.info('Invoice payment recorded via PayFast', {
      transactionId, invoiceId: tx.invoice_id, amount: itnAmount, status: 'completed',
    }, 'PaymentGateway');
  }

  log.info('ITN processed', { transactionId, pfStatus, newStatus }, 'PaymentGateway');
  return { valid: true, transactionId };
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

/**
 * Enable online payment for an invoice and generate a payment URL.
 */
export async function enableOnlinePayment(companyId: string, invoiceId: string): Promise<string> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3101';

  // Create a portal payment link token for public access
  const linkRows = (await sql`
    INSERT INTO portal_payment_links (invoice_id, client_id, amount)
    SELECT ci.id, ci.client_id, ci.total_amount - COALESCE(ci.amount_paid, 0)
    FROM customer_invoices ci
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    RETURNING token
  `) as Row[];

  if (!linkRows[0]) throw new Error('Invoice not found or no balance due');

  const token = linkRows[0].token as string;
  const paymentUrl = `${appUrl}/portal/pay/${token}`;

  // Store the payment URL and enable online payments on the invoice
  await sql`
    UPDATE customer_invoices
    SET online_payment_enabled = true, payment_url = ${paymentUrl}, updated_at = NOW()
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Online payment enabled', { invoiceId, paymentUrl }, 'PaymentGateway');
  return paymentUrl;
}

// ── Mapper ──────────────────────────────────────────────────────────────────

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

function mapTransaction(r: Row): PaymentTransaction {
  return {
    id: r.id,
    companyId: r.company_id,
    invoiceId: r.invoice_id,
    gateway: r.gateway,
    gatewayRef: r.gateway_ref,
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status,
    customerEmail: r.customer_email,
    customerName: r.customer_name,
    paymentMethod: r.payment_method,
    metadata: r.metadata || {},
    errorMessage: r.error_message,
    paidAt: r.paid_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
