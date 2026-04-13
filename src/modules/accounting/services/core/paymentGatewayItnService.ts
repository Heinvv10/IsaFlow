/**
 * Payment Gateway ITN Service
 * Handles PayFast Instant Transaction Notification (ITN) validation and processing.
 * Re-exported from paymentGatewayService for backward compatibility.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { generateSignature, isPayFastIp, getConfig } from './paymentGatewayCore';
import type { DbRow } from '@/types/db';


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
  `) as DbRow[];

  if (!txRows[0]) {
    log.error('ITN rejected: transaction not found', { transactionId }, 'PaymentGateway');
    return { valid: false, transactionId };
  }

  const tx = txRows[0];

  // 4. Verify amount (compare integer cents to avoid float precision errors)
  const itnCents = Math.round(parseFloat(body.amount_gross || '0') * 100);
  const itnAmount = itnCents / 100;
  const expectedCents = Math.round(Number(tx.amount) * 100);
  if (itnCents !== expectedCents) {
    log.error('ITN rejected: amount mismatch', { expectedCents, receivedCents: itnCents }, 'PaymentGateway');
    await sql`
      UPDATE payment_transactions
      SET status = 'failed', error_message = 'Amount mismatch', updated_at = NOW()
      WHERE id = ${transactionId}::UUID
    `;
    return { valid: false, transactionId };
  }

  // 5. Map PayFast status to our status
  const pfStatus = (body.payment_status || '').toUpperCase();
  let newStatus: string;
  switch (pfStatus) {
    case 'COMPLETE':   newStatus = 'completed'; break;
    case 'FAILED':     newStatus = 'failed';    break;
    case 'PENDING':    newStatus = 'processing'; break;
    case 'CANCELLED':  newStatus = 'cancelled'; break;
    default:           newStatus = 'processing';
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

  // 7. If completed, update the invoice balance
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
