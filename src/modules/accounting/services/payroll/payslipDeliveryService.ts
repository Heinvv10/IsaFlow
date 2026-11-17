/**
 * Email a final pay run's payslips (wave 6 PE): one protected PDF per employee, through an injected Mailer (spec
 * rule 11; the route passes `sendEmail`, the tests a capture mailer), each attempt recorded in payslip_deliveries.
 *
 * Judged before the first send or write (rule 12), in this order: the platform switch payroll_payslip_email (rule 20,
 * F7; off = FEATURE_DISABLED 403), the company setting (off = SETTING_OFF 409), the run (this company's; final, i.e.
 * approved or paid with an approval time, else NOT_FINAL), the run-kind guard (getPayslips), the slips' details frozen
 * at this approval (PS3; a run approved before PS3 prints details as at download and is DETAILS_NOT_FROZEN), then
 * every recipient: no address (NO_EMAIL), neither ID nor passport number to protect the PDF with (NO_ID_OR_PASSPORT,
 * never sent unprotected), or already sent for this approval (ALREADY_SENT, unless `resend`). Those are skipped and
 * named, never refused. Then the rate limit for the count left (`admit`; RATE_LIMITED 429).
 *
 * Idempotent per (run, employee, approval): a reopen and re-approval is another document, so it may be sent again.
 * LOCKS: the run's advisory lock (payslip_email:<run>) and its header FOR SHARE, inside withBoundedLockWait's
 * savepoint and held to the end of the request transaction, so a second send waits and then sees this one's rows,
 * and a reopen waits for the sends to finish. Each send is bounded (SEND_DEADLINE_MS).
 * One audit_log `export` row per request that attempted any send (the slips carry pay and tax details).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { EmailOptions, EmailResult } from '@/modules/accounting/services/core/emailService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { withBoundedLockWait } from './payrollRunLock';
import { getPayslips, PayslipNotFound, type PayslipRun } from './payslipModel';
import { payslipEmailMessage, payslipPassword, renderEmailPayslip } from './payslipEmailPdf';
import { PayslipEmailRefusal } from './payslipDeliveryRefusal';
import { companyPayslipEmailEnabled, PAYSLIP_EMAIL_FLAG } from './payslipEmailSettings';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export type Mailer = (options: EmailOptions) => Promise<EmailResult>;

const SEND_DEADLINE_MS = 30_000;
const SMTP_TIMEOUTS_MS = { connection: 10_000, greeting: 10_000, socket: 20_000 };

export type SkipReason = 'NO_EMAIL' | 'NO_ID_OR_PASSPORT' | 'ALREADY_SENT';
interface Who { employeeId: string; employeeNumber: string; employeeName: string }
export interface PayslipEmailOutcome {
  sent: Array<Who & { sha256: string }>;
  failed: Array<Who & { error: string }>;
  skipped: Array<Who & { reason: SkipReason }>;
}

interface Recipient { id: string; email: string | null; id_number: string | null; passport_number: string | null }

async function lockRun(companyId: string, runId: string): Promise<DbRow | null> {
  return withBoundedLockWait(runId, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payslip_email:${runId}`}, 0))`;
    return ((await tx`
      SELECT status, COALESCE(approved_at, approval_grandfathered_at) AS final_at
        FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid AND status <> 'cancelled'
       FOR SHARE
    `) as DbRow[])[0] ?? null;
  });
}

async function readSlips(companyId: string, runId: string, employeeIds?: string[]): Promise<PayslipRun> {
  try {
    return await getPayslips(companyId, runId, employeeIds);
  } catch (err) {
    if (err instanceof PayslipNotFound) throw new PayslipEmailRefusal('NOT_FOUND', err.message);
    throw err;
  }
}

/** Employees already sent this run's slip at its current approval. */
async function alreadySent(companyId: string, runId: string): Promise<Set<string>> {
  const rows = (await sql`
    SELECT DISTINCT d.employee_id::text AS employee_id
      FROM payslip_deliveries d JOIN payroll_run_headers h ON h.id = d.run_id AND h.company_id = d.company_id
     WHERE d.company_id = ${companyId}::uuid AND d.run_id = ${runId}::uuid AND d.status = 'sent'
       AND d.run_approved_at = COALESCE(h.approved_at, h.approval_grandfathered_at)
  `) as Array<{ employee_id: string }>;
  return new Set(rows.map((r) => r.employee_id));
}

async function recipients(companyId: string, ids: string[]): Promise<Map<string, Recipient>> {
  const rows = (await sql`
    SELECT id::text AS id, email, id_number, passport_number FROM payroll_employees
     WHERE company_id = ${companyId}::uuid AND id::text = ANY(${ids}::text[])
  `) as Recipient[];
  return new Map(rows.map((r) => [r.id, r]));
}

async function record(o: {
  companyId: string; runId: string; employeeId: string; email: string; sha256: string; resend: boolean; sentBy: string;
  result: { messageId: string | null; error: string | null };
}): Promise<void> {
  await sql`
    INSERT INTO payslip_deliveries
      (company_id, run_id, employee_id, run_approved_at, recipient_email, pdf_sha256, status, message_id, error, resend, sent_by)
    SELECT ${o.companyId}::uuid, h.id, ${o.employeeId}::uuid, COALESCE(h.approved_at, h.approval_grandfathered_at), ${o.email},
           ${o.sha256}, ${o.result.error === null ? 'sent' : 'failed'}, ${o.result.messageId}, ${o.result.error}, ${o.resend}, ${o.sentBy}
      FROM payroll_run_headers h WHERE h.id = ${o.runId}::uuid AND h.company_id = ${o.companyId}::uuid
  `;
}

async function deliver(mailer: Mailer, options: EmailOptions): Promise<{ messageId: string | null; error: string | null }> {
  try {
    const r = await mailer(options);
    if (r.success) return { messageId: r.messageId?.slice(0, 998) ?? null, error: null };
    return { messageId: null, error: (r.error || 'The mail server did not accept the message').slice(0, 500) };
  } catch (err) {
    log.error('Payslip email send threw', { error: err instanceof Error ? err.message : String(err) }, 'payslip-email');
    return { messageId: null, error: 'The send failed before the mail server answered' };
  }
}

export async function sendPayslipEmails(opts: {
  companyId: string; runId: string; employeeIds?: string[]; resend: boolean; actor: EmployeeEmailActor;
  mailer: Mailer; admit: (count: number) => Promise<boolean>;
}): Promise<PayslipEmailOutcome> {
  const { companyId, runId, resend, actor, mailer } = opts;
  if (!(await hasFeature(companyId, PAYSLIP_EMAIL_FLAG))) {
    throw new PayslipEmailRefusal('FEATURE_DISABLED', 'Emailing payslips is not switched on for IsaFlow yet.');
  }
  if (!(await companyPayslipEmailEnabled(companyId))) {
    throw new PayslipEmailRefusal('SETTING_OFF', 'Emailing payslips is off for this company. An owner or admin can turn it on.');
  }
  const header = await lockRun(companyId, runId);
  if (!header) throw new PayslipEmailRefusal('NOT_FOUND', 'Pay run not found');
  if (!['approved', 'paid'].includes(String(header.status)) || header.final_at == null) {
    throw new PayslipEmailRefusal('NOT_FINAL', 'Only an approved pay run\'s payslips can be emailed.');
  }
  const run = await readSlips(companyId, runId, opts.employeeIds);
  if (!run.final || run.detailsAsAt !== 'approval') {
    throw new PayslipEmailRefusal('DETAILS_NOT_FROZEN',
      'This run was approved before payslip details were kept at approval, so its payslips show details as at download. Download them instead.');
  }
  const approvedAt = new Date(header.final_at as string | Date);
  const people = await recipients(companyId, run.payslips.map((p) => p.employeeId));
  const done = resend ? new Set<string>() : await alreadySent(companyId, runId);

  const out: PayslipEmailOutcome = { sent: [], failed: [], skipped: [] };
  const queue: Array<{ slip: PayslipRun['payslips'][number]; email: string; password: NonNullable<ReturnType<typeof payslipPassword>> }> = [];
  for (const slip of run.payslips) {
    const who = { employeeId: slip.employeeId, employeeNumber: slip.employeeNumber, employeeName: slip.employeeName };
    const p = people.get(slip.employeeId);
    const password = p ? payslipPassword({ idNumber: p.id_number, passportNumber: p.passport_number }) : null;
    if (!p?.email) out.skipped.push({ ...who, reason: 'NO_EMAIL' });
    else if (!password) out.skipped.push({ ...who, reason: 'NO_ID_OR_PASSPORT' });
    else if (done.has(slip.employeeId)) out.skipped.push({ ...who, reason: 'ALREADY_SENT' });
    else queue.push({ slip, email: p.email, password });
  }
  if (queue.length === 0) return out;
  if (!(await opts.admit(queue.length))) {
    throw new PayslipEmailRefusal('RATE_LIMITED', 'Too many payslip emails for now. Try again later.');
  }

  for (const { slip, email, password } of queue) {
    const who = { employeeId: slip.employeeId, employeeNumber: slip.employeeNumber, employeeName: slip.employeeName };
    const { filename, pdf, sha256 } = await renderEmailPayslip(run, slip, password.password, approvedAt);
    const message = payslipEmailMessage(run, slip, password.source);
    const result = await deliver(mailer, {
      to: email, subject: message.subject, html: message.html,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
      _log: { companyId, emailType: 'other', sentBy: actor.userId },
      smtpTimeoutsMs: SMTP_TIMEOUTS_MS, deadlineMs: SEND_DEADLINE_MS,
    });
    await record({ companyId, runId, employeeId: slip.employeeId, email, sha256, resend, sentBy: actor.userId, result });
    if (result.error === null) out.sent.push({ ...who, sha256 });
    else out.failed.push({ ...who, error: 'The mail server did not accept it. Check the address and try again.' });
  }
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'export', entityType: 'payslip_email', entityId: runId,
    changes: { fields: [], metadata: {
      sent: out.sent.map((s) => s.employeeId).join(','), failed: out.failed.map((f) => f.employeeId).join(','), resend: String(resend),
    } },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  log.info('Payslips emailed', { companyId, runId, sent: out.sent.length, failed: out.failed.length, skipped: out.skipped.length }, 'payslip-email');
  return out;
}
