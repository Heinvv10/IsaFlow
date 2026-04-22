/**
 * WhatsApp Chase Service — PRD-05 Phase 8
 * Outbound WhatsApp invoice chase for missing-invoice alerts.
 * Extracted from missingInvoiceChaseService to keep file sizes ≤ 300 lines.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import type { ChaseTemplateInput } from './missingInvoiceChaseService';
import { sendWhatsAppMessage } from './whatsAppReplyService';

type Row = DbRow;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDateString(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compose a concise WhatsApp chase message (≤ 400 chars, text-only).
 * Pure function — same input shape as composeChaseEmail minus `html`.
 *
 * Example output:
 *   "Hi Eskom, this is Acme Corp. We have not received your invoice for
 *    April 2025 (~R12000). Please send it at your earliest convenience."
 */
export function composeChaseWhatsApp(input: ChaseTemplateInput): { body: string } {
  const { supplierName, companyName, expectedBy, expectedAmount } = input;
  const monthYear = new Date(expectedBy).toLocaleString('en-ZA', {
    month: 'long', year: 'numeric',
  });
  const amtStr = expectedAmount != null ? ` (~R${expectedAmount.toFixed(0)})` : '';
  const body =
    `Hi ${supplierName}, this is ${companyName}. ` +
    `We have not received your invoice for ${monthYear}${amtStr}. ` +
    `Please send it at your earliest convenience. Thank you.`;
  return { body };
}

/**
 * Send a WhatsApp chase to the supplier linked to the given alert.
 *
 * Returns { sent: false } when:
 *   - company.whatsapp_chase_enabled = false → reason: 'whatsapp chase disabled'
 *   - supplier.whatsapp_number IS NULL       → reason: 'no supplier whatsapp number'
 *   - alert not found                        → reason: 'alert not found'
 *   - Twilio not configured / send failure   → reason: from sendWhatsAppMessage
 *
 * On success, sets alert status='chased', chase_method='whatsapp'.
 */
export async function sendWhatsAppChase(
  companyId: string,
  alertId: string,
  userId: string,
): Promise<{ sent: boolean; reason?: string }> {
  void userId; // reserved for audit log in a future phase

  const [alertRow] = (await sql`
    SELECT a.*, s.name AS supplier_name, s.whatsapp_number AS supplier_wa,
           se.last_invoice_date AS exp_last_invoice_date
    FROM expected_invoice_alerts a
    JOIN suppliers s ON s.id = a.supplier_id
    LEFT JOIN supplier_expectations se ON se.id = a.expectation_id
    WHERE a.id = ${alertId}::uuid
      AND a.company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];

  if (!alertRow) {
    log.warn('sendWhatsAppChase: alert not found', { alertId, companyId }, 'whatsapp-chase');
    return { sent: false, reason: 'alert not found' };
  }

  const waNumber = alertRow.supplier_wa ? String(alertRow.supplier_wa) : null;
  if (!waNumber) {
    return { sent: false, reason: 'no supplier whatsapp number' };
  }

  const [companyRow] = (await sql`
    SELECT name, whatsapp_chase_enabled
    FROM companies
    WHERE id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];

  const chaseEnabled = Boolean(companyRow?.whatsapp_chase_enabled);
  if (!chaseEnabled) {
    return { sent: false, reason: 'whatsapp chase disabled' };
  }

  const companyName = companyRow?.name ? String(companyRow.name) : 'IsaFlow';
  const tmplInput: ChaseTemplateInput = {
    supplierName: String(alertRow.supplier_name ?? ''),
    companyName,
    expectedBy: toDateString(alertRow.expected_by as Date | string)!,
    expectedAmount:
      alertRow.expected_amount != null ? Number(alertRow.expected_amount) : null,
    lastInvoiceDate: toDateString(alertRow.exp_last_invoice_date as Date | string | null),
  };

  const { body } = composeChaseWhatsApp(tmplInput);

  // Normalise to "whatsapp:+..." format
  const to = waNumber.startsWith('whatsapp:') ? waNumber : `whatsapp:${waNumber}`;

  const sendResult = await sendWhatsAppMessage(to, body);

  if (!sendResult.sent) {
    log.warn('sendWhatsAppChase: message send failed', {
      alertId, companyId, reason: sendResult.reason,
    }, 'whatsapp-chase');
    return { sent: false, reason: sendResult.reason };
  }

  await sql`
    UPDATE expected_invoice_alerts SET
      status            = 'chased',
      chased_at         = NOW(),
      chase_method      = 'whatsapp',
      chase_to_address  = ${to},
      updated_at        = NOW()
    WHERE id = ${alertId}::uuid
      AND company_id = ${companyId}::uuid
  `;

  log.info('WhatsApp chase sent', {
    alertId, companyId, supplierId: alertRow.supplier_id, to,
  }, 'whatsapp-chase');

  return { sent: true };
}
