/**
 * payslip_deliveries reads and the one write (wave 6 PE, migration 999o).
 *
 * `recordDelivery` runs right after each send, in its OWN short transaction (withOwnCompanyTx; review #1542 S3): the
 * delivery row, its email_log row and its audit_log `export` row (naming the recipient address, S5) commit at once,
 * whatever the request does afterwards, so a request that rolls back can never erase the record of a mail that left
 * and make the next click mail it again. The 999o trigger stamps sent_by from the session user (S4).
 *
 * Status: 'sent' (the server accepted it), 'failed' (provably not sent), 'unknown' (the server may have taken it: a
 * deadline fired; S2). 'sent' and 'unknown' both count as delivered for this approval: a plain send skips them.
 */
import { sql } from '@/lib/neon';
import { withOwnCompanyTx } from '@/lib/auth/companyOwnTx';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { logEmailAttempt } from '@/modules/accounting/services/core/emailService';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export type DeliveryStatus = 'sent' | 'failed' | 'unknown';

export async function recordDelivery(o: {
  companyId: string; runId: string; employeeId: string; email: string; subject: string; sha256: string; resend: boolean;
  status: DeliveryStatus; messageId: string | null; error: string | null; actor: EmployeeEmailActor;
}): Promise<void> {
  const { companyId, runId, employeeId, actor } = o;
  await withOwnCompanyTx(async () => {
    await sql`
      INSERT INTO payslip_deliveries
        (company_id, run_id, employee_id, run_approved_at, recipient_email, pdf_sha256, status, message_id, error, resend)
      SELECT ${companyId}::uuid, h.id, ${employeeId}::uuid, COALESCE(h.approved_at, h.approval_grandfathered_at), ${o.email},
             ${o.sha256}, ${o.status}, ${o.messageId}, ${o.error}, ${o.resend}
        FROM payroll_run_headers h WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
    `;
    await logEmailAttempt({
      companyId, recipientEmail: o.email, subject: o.subject, emailType: 'other', sentBy: actor.userId,
      status: o.status === 'sent' ? 'sent' : 'failed', errorMessage: o.error === null ? undefined : `${o.status}: ${o.error}`,
    });
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'export', entityType: 'payslip_email', entityId: runId,
      changes: { fields: [], metadata: {
        employeeId, recipient: o.email, status: o.status, sha256: o.sha256, resend: String(o.resend),
      } },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    });
  });
}

/**
 * Each employee's LATEST attempt of this run at its current approval: 'sent' and 'unknown' mean delivered (a plain
 * send skips them); 'failed' means the last try was refused (a plain send of the whole run skips it too, review
 * #1542 D-I1, so a batch never re-tries the same bad address ahead of everyone else; naming the employee retries).
 */
export async function latestAttempts(companyId: string, runId: string): Promise<Map<string, DeliveryStatus>> {
  const rows = (await sql`
    SELECT DISTINCT ON (d.employee_id) d.employee_id::text AS employee_id, d.status
      FROM payslip_deliveries d JOIN payroll_run_headers h ON h.id = d.run_id AND h.company_id = d.company_id
     WHERE d.company_id = ${companyId}::uuid AND d.run_id = ${runId}::uuid
       AND d.run_approved_at = COALESCE(h.approved_at, h.approval_grandfathered_at)
     ORDER BY d.employee_id, d.created_at DESC, d.id DESC
  `) as Array<{ employee_id: string; status: DeliveryStatus }>;
  return new Map(rows.map((r) => [r.employee_id, r.status]));
}

/** Where each employee's last payslip email went (any run), for naming a changed address. */
export async function lastSentTo(companyId: string, employeeIds: string[]): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT DISTINCT ON (employee_id) employee_id::text AS employee_id, recipient_email FROM payslip_deliveries
     WHERE company_id = ${companyId}::uuid AND status IN ('sent', 'unknown') AND employee_id::text = ANY(${employeeIds}::text[])
     ORDER BY employee_id, created_at DESC, id DESC
  `) as Array<{ employee_id: string; recipient_email: string }>;
  return new Map(rows.map((r) => [r.employee_id, r.recipient_email]));
}

export interface RunDelivery {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  status: DeliveryStatus;
  recipient: string;
  at: string;
  attempts: number;
}

/** Each employee's latest delivery of this run at its current approval (review #1542 A5), employee-number order. */
export async function listRunDeliveries(companyId: string, runId: string): Promise<RunDelivery[]> {
  const rows = (await sql`
    SELECT DISTINCT ON (d.employee_id) d.employee_id::text AS employee_id, e.employee_number, e.first_name, e.last_name,
           d.status, d.recipient_email, d.created_at,
           count(*) OVER (PARTITION BY d.employee_id) AS attempts
      FROM payslip_deliveries d
      JOIN payroll_run_headers h ON h.id = d.run_id AND h.company_id = d.company_id
      JOIN payroll_employees e ON e.id = d.employee_id AND e.company_id = d.company_id
     WHERE d.company_id = ${companyId}::uuid AND d.run_id = ${runId}::uuid
       AND d.run_approved_at = COALESCE(h.approved_at, h.approval_grandfathered_at)
     ORDER BY d.employee_id, d.created_at DESC, d.id DESC
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    employeeId: String(r.employee_id), employeeNumber: String(r.employee_number),
    employeeName: `${String(r.first_name)} ${String(r.last_name)}`.trim(), status: r.status as DeliveryStatus,
    recipient: String(r.recipient_email), attempts: Number(r.attempts),
    at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  })).sort((x, y) => x.employeeNumber.localeCompare(y.employeeNumber, undefined, { numeric: true }));
}
