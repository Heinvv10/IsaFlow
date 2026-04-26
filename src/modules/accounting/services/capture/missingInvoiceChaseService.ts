/**
 * Missing Invoice Chase Service — PRD-05 Phase 6
 * Gap detection, alert management, and email chase dispatch.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { sendEmail } from '@/modules/accounting/services/core/emailService';

type Row = DbRow;
// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExpectedAlert {
  id: string;
  companyId: string;
  supplierId: string;
  supplierName: string;
  supplierEmail: string | null;
  supplierWhatsappNumber: string | null;
  expectationId: string | null;
  expectedBy: string;
  expectedAmount: number | null;
  daysOverdue: number;
  status: 'pending' | 'chased' | 'resolved' | 'dismissed';
  chasedAt: string | null;
  chaseMethod: 'email' | 'whatsapp' | null;
  chaseToAddress: string | null;
  resolvedInvoiceId: string | null;
  resolvedAt: string | null;
  dismissedReason: string | null;
}

export interface ChaseTemplateInput {
  supplierName: string;
  companyName: string;
  expectedBy: string;
  expectedAmount: number | null;
  lastInvoiceDate: string | null;
}

// Re-export Phase 8 WhatsApp-chase siblings so consumers (tests + UI) can
// import everything from one place; the implementation lives in
// whatsAppChaseService.ts to keep this file under the 300-line budget.
export { sendWhatsAppChase, composeChaseWhatsApp } from './whatsAppChaseService';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDateString(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function mapAlertRow(row: Row, today: string): ExpectedAlert {
  const expectedBy = toDateString(row.expected_by as Date | string)!;
  const todayMs = new Date(today).getTime();
  const expectedMs = new Date(expectedBy).getTime();
  const daysOverdue = Math.max(0, Math.round((todayMs - expectedMs) / 86_400_000));

  return {
    id: String(row.id),
    companyId: String(row.company_id),
    supplierId: String(row.supplier_id),
    supplierName: String(row.supplier_name ?? ''),
    supplierEmail: row.supplier_email ? String(row.supplier_email) : null,
    supplierWhatsappNumber: row.supplier_whatsapp_number ? String(row.supplier_whatsapp_number) : null,
    expectationId: row.expectation_id ? String(row.expectation_id) : null,
    expectedBy,
    expectedAmount: row.expected_amount != null ? Number(row.expected_amount) : null,
    daysOverdue,
    status: row.status as ExpectedAlert['status'],
    chasedAt: toDateString(row.chased_at as Date | string | null),
    chaseMethod: row.chase_method as ExpectedAlert['chaseMethod'] ?? null,
    chaseToAddress: row.chase_to_address ? String(row.chase_to_address) : null,
    resolvedInvoiceId: row.resolved_invoice_id ? String(row.resolved_invoice_id) : null,
    resolvedAt: toDateString(row.resolved_at as Date | string | null),
    dismissedReason: row.dismissed_reason ? String(row.dismissed_reason) : null,
  };
}

/** Add months to an ISO date string. */
function addPeriod(isoDate: string, cadence: 'monthly' | 'quarterly' | 'annual'): string {
  const d = new Date(isoDate);
  if (cadence === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (cadence === 'quarterly') d.setMonth(d.getMonth() + 3);
  else d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listAlerts(
  companyId: string,
  statusFilter?: ExpectedAlert['status'],
): Promise<ExpectedAlert[]> {
  const today = new Date().toISOString().slice(0, 10);
  let rows: Row[];
  if (statusFilter) {
    rows = await sql`
      SELECT a.*, s.name AS supplier_name, s.email AS supplier_email, s.whatsapp_number AS supplier_whatsapp_number
      FROM expected_invoice_alerts a
      JOIN suppliers s ON s.id = a.supplier_id
      WHERE a.company_id = ${companyId}::uuid
        AND a.status = ${statusFilter}
      ORDER BY a.expected_by DESC
    ` as Row[];
  } else {
    rows = await sql`
      SELECT a.*, s.name AS supplier_name, s.email AS supplier_email, s.whatsapp_number AS supplier_whatsapp_number
      FROM expected_invoice_alerts a
      JOIN suppliers s ON s.id = a.supplier_id
      WHERE a.company_id = ${companyId}::uuid
      ORDER BY a.expected_by DESC
    ` as Row[];
  }
  return rows.map(r => mapAlertRow(r, today));
}

export async function detectGaps(
  companyId: string,
  today?: string,
): Promise<{ created: number; unchanged: number }> {
  const todayStr = today ?? new Date().toISOString().slice(0, 10);

  // Fetch all locked expectations
  const expectations = await sql`
    SELECT id, supplier_id, cadence, last_invoice_date, expected_day_of_month, expected_amount
    FROM supplier_expectations
    WHERE company_id = ${companyId}::uuid
      AND status = 'locked'
  ` as Row[];

  let created = 0;
  let unchanged = 0;

  for (const exp of expectations) {
    const lastDate = toDateString(exp.last_invoice_date as Date | string | null);
    if (!lastDate) continue;

    const cadence = exp.cadence as 'monthly' | 'quarterly' | 'annual';
    const expectedBy = addPeriod(lastDate, cadence);

    // Only alert if expected_by <= today
    if (expectedBy > todayStr) { unchanged++; continue; }

    // Check if a matching invoice arrived within ±7 days
    const [matchRow] = await sql`
      SELECT id FROM supplier_invoices
      WHERE company_id = ${companyId}::uuid
        AND supplier_id = ${String(exp.supplier_id)}::uuid
        AND deleted_at IS NULL
        AND invoice_date BETWEEN (${expectedBy}::date - INTERVAL '7 days')
                              AND (${expectedBy}::date + INTERVAL '7 days')
      LIMIT 1
    ` as Row[];

    if (matchRow) { unchanged++; continue; }

    // Upsert alert (idempotent via UNIQUE constraint)
    const result = await sql`
      INSERT INTO expected_invoice_alerts (
        company_id, supplier_id, expectation_id,
        expected_by, expected_amount, status
      ) VALUES (
        ${companyId}::uuid,
        ${String(exp.supplier_id)}::uuid,
        ${String(exp.id)}::uuid,
        ${expectedBy}::date,
        ${exp.expected_amount != null ? Number(exp.expected_amount) : null},
        'pending'
      )
      ON CONFLICT (company_id, supplier_id, expected_by) DO NOTHING
      RETURNING id
    ` as Row[];

    if (result.length > 0) {
      created++;
      log.info('Created expected_invoice_alert', {
        companyId, supplierId: exp.supplier_id, expectedBy,
      }, 'missingInvoiceChase');
    } else {
      unchanged++;
    }
  }

  return { created, unchanged };
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });
}

export function composeChaseEmail(input: ChaseTemplateInput): {
  subject: string; html: string; text: string;
} {
  const { supplierName, companyName, expectedBy, expectedAmount, lastInvoiceDate } = input;
  const monthYear = new Date(expectedBy).toLocaleString('en-ZA', { month: 'long', year: 'numeric' });
  const subject = `Reminder: ${supplierName} invoice for ${monthYear}`;
  const amtStr = expectedAmount != null ? `R${expectedAmount.toFixed(2)}` : null;
  // Pentest M18: DB-sourced names can contain script/HTML. Escape before interpolation.
  const safeSupplier = escHtml(supplierName);
  const safeCompany = escHtml(companyName);
  const safeExpectedBy = escHtml(expectedBy);
  const safeLastInvoice = lastInvoiceDate ? escHtml(lastInvoiceDate) : null;
  const html = [
    `<p>Dear ${safeSupplier},</p>`,
    `<p>We are writing on behalf of <strong>${safeCompany}</strong> to request the invoice expected by <strong>${safeExpectedBy}</strong>.</p>`,
    amtStr ? `<p>Expected amount: approximately <strong>${amtStr}</strong>.</p>` : '',
    safeLastInvoice ? `<p>Last invoice received: <strong>${safeLastInvoice}</strong>.</p>` : '',
    `<p>Please send the outstanding invoice at your earliest convenience, or disregard if already sent.</p>`,
    `<p>Kind regards,<br/><strong>${safeCompany} Accounts Team</strong></p>`,
  ].filter(Boolean).join('\n');
  const text = [
    `Dear ${supplierName},`,
    `We are writing on behalf of ${companyName} to request the invoice expected by ${expectedBy}.`,
    amtStr ? `Expected amount: ${amtStr}` : null,
    lastInvoiceDate ? `Last invoice received: ${lastInvoiceDate}` : null,
    'Please send the outstanding invoice at your earliest convenience.',
    `Kind regards,\n${companyName} Accounts Team`,
  ].filter((l): l is string => l !== null).join('\n\n');
  return { subject, html, text };
}

export async function sendEmailChase(
  companyId: string,
  alertId: string,
  userId: string,
): Promise<{ sent: boolean; reason?: string }> {
  // Load alert
  const [alertRow] = await sql`
    SELECT a.*, s.name AS supplier_name, s.email AS supplier_email,
           se.last_invoice_date AS exp_last_invoice_date
    FROM expected_invoice_alerts a
    JOIN suppliers s ON s.id = a.supplier_id
    LEFT JOIN supplier_expectations se ON se.id = a.expectation_id
    WHERE a.id = ${alertId}::uuid
      AND a.company_id = ${companyId}::uuid
    LIMIT 1
  ` as Row[];

  if (!alertRow) {
    log.warn('sendEmailChase: alert not found', { alertId, companyId }, 'missingInvoiceChase');
    return { sent: false, reason: 'alert not found' };
  }

  const supplierEmail = alertRow.supplier_email ? String(alertRow.supplier_email) : null;
  if (!supplierEmail) {
    return { sent: false, reason: 'no supplier email' };
  }

  // Load company name
  const [companyRow] = await sql`
    SELECT name FROM companies WHERE id = ${companyId}::uuid LIMIT 1
  ` as Row[];
  const companyName = companyRow?.name ? String(companyRow.name) : 'IsaFlow';

  const tmplInput: ChaseTemplateInput = {
    supplierName: String(alertRow.supplier_name ?? ''),
    companyName,
    expectedBy: toDateString(alertRow.expected_by as Date | string)!,
    expectedAmount: alertRow.expected_amount != null ? Number(alertRow.expected_amount) : null,
    lastInvoiceDate: toDateString(alertRow.exp_last_invoice_date as Date | string | null),
  };

  const { subject, html } = composeChaseEmail(tmplInput);

  const result = await sendEmail({
    to: supplierEmail,
    subject,
    html,
    _log: { companyId, emailType: 'other', sentBy: userId },
  });

  if (!result.success) {
    log.warn('sendEmailChase: email send failed', {
      alertId, error: result.error,
    }, 'missingInvoiceChase');
    return { sent: false, reason: result.error ?? 'send failed' };
  }

  // Update alert
  await sql`
    UPDATE expected_invoice_alerts SET
      status            = 'chased',
      chased_at         = NOW(),
      chase_method      = 'email',
      chase_to_address  = ${supplierEmail},
      updated_at        = NOW()
    WHERE id = ${alertId}::uuid
      AND company_id = ${companyId}::uuid
  `;

  log.info('Chase email sent', {
    alertId, companyId, supplierId: alertRow.supplier_id, to: supplierEmail,
  }, 'missingInvoiceChase');

  return { sent: true };
}

export async function dismissAlert(
  companyId: string,
  alertId: string,
  reason: string,
  _userId: string,
): Promise<void> {
  await sql`
    UPDATE expected_invoice_alerts SET
      status            = 'dismissed',
      dismissed_reason  = ${reason},
      updated_at        = NOW()
    WHERE id = ${alertId}::uuid
      AND company_id = ${companyId}::uuid
  `;
  log.info('Alert dismissed', { alertId, companyId, reason }, 'missingInvoiceChase');
}
