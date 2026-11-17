/**
 * Email a final pay run's payslips (wave 6 PE): one protected PDF per employee, through an injected Mailer (spec
 * rule 11; the route passes `sendEmail`, the tests a capture mailer), each attempt recorded in payslip_deliveries.
 *
 * Judged before the first send or write (rule 12), in this order: the platform switch payroll_payslip_email (rule 20,
 * F7; off = FEATURE_DISABLED 403), the company setting (off = SETTING_OFF 409), the run (this company's; final, i.e.
 * approved or paid with an approval time, else NOT_FINAL), the run-kind guard (getPayslips), the slips' details frozen
 * at this approval (PS3; a run approved before PS3 prints details as at download and is DETAILS_NOT_FROZEN), then
 * every recipient: no address (NO_EMAIL), neither ID nor passport number to protect the PDF with (NO_ID_OR_PASSPORT,
 * never sent unprotected), or already delivered for this approval (ALREADY_SENT: sent, or 'unknown' because the mail
 * server may have taken it; unless `resend`). Those are skipped and named, never refused. Then the rate limit for
 * the count this request will send (`admit`; RATE_LIMITED 429).
 *
 * At most `limits.maxSends` slips per request, and none started once `limits.budgetMs` has passed (review #1542 A1:
 * a request must finish well inside the proxy's 60 s); the rest are `remaining`, and the caller asks again. Each
 * send's row is committed on its own right after it (payslipDeliveryRecord, S3), so nothing that happens to the
 * request afterwards can make a slip go twice.
 *
 * A slip sent to an address other than the one that employee's last payslip went to is NAMED (`addressChanged`).
 * Idempotent per (run, employee, approval): a reopen and re-approval is another document, so it may be sent again.
 * LOCKS: the run's advisory lock (payslip_email:<run>) then its header FOR SHARE, taken in withBoundedLockWait (5 s;
 * a leaf lock, payrollRunLock.ts LOCK ORDER) and held to the end of the request. A second send of the same run, or a
 * reopen, arriving meanwhile is refused after 5 s (ROW_LOCK_TIMEOUT, a retry), not queued behind the sends.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { EmailOptions, EmailResult } from '@/modules/accounting/services/core/emailService';
import { hasFeature } from '@/modules/admin/services/featureFlagService';
import { withBoundedLockWait } from './payrollRunLock';
import { getPayslips, PayslipNotFound, type PayslipRun } from './payslipModel';
import { payslipEmailMessage, payslipPassword, renderEmailPayslip } from './payslipEmailPdf';
import { PayslipEmailRefusal } from './payslipDeliveryRefusal';
import { companyPayslipEmailEnabled, PAYSLIP_EMAIL_FLAG } from './payslipEmailSettings';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';
import { alreadyDelivered, lastSentTo, recordDelivery, type DeliveryStatus } from './payslipDeliveryRecord';

export type Mailer = (options: EmailOptions) => Promise<EmailResult>;

const SEND_DEADLINE_MS = 15_000;
const SMTP_TIMEOUTS_MS = { connection: 5_000, greeting: 5_000, socket: 10_000 };
/** Per request: at most 20 sends, none started after 20 s (+ one 15 s deadline = 35 s, inside nginx's 60 s). */
export const SEND_LIMITS = { maxSends: 20, budgetMs: 20_000 } as const;
export type SendLimits = { maxSends: number; budgetMs: number };

export type SkipReason = 'NO_EMAIL' | 'NO_ID_OR_PASSPORT' | 'ALREADY_SENT';
interface Who { employeeId: string; employeeNumber: string; employeeName: string }
export interface PayslipEmailOutcome {
  sent: Array<Who & { sha256: string; addressChanged: boolean }>;
  failed: Array<Who & { error: string }>;
  /** The mail server may have taken it (a deadline fired): not sent again unless a person resends it. */
  uncertain: Who[];
  skipped: Array<Who & { reason: SkipReason }>;
  /** Slips still to send after this request (the cap or the time budget): ask again. */
  remaining: number;
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



async function recipients(companyId: string, ids: string[]): Promise<Map<string, Recipient>> {
  const rows = (await sql`
    SELECT id::text AS id, email, id_number, passport_number FROM payroll_employees
     WHERE company_id = ${companyId}::uuid AND id::text = ANY(${ids}::text[])
  `) as Recipient[];
  return new Map(rows.map((r) => [r.id, r]));
}


/** The mail server's answer: sent; failed (provably not sent); or unknown (it may have taken the message; S2). */
async function deliver(mailer: Mailer, options: EmailOptions): Promise<{ status: DeliveryStatus; messageId: string | null; error: string | null }> {
  try {
    const r = await mailer(options);
    if (r.success) return { status: 'sent', messageId: r.messageId?.slice(0, 998) ?? null, error: null };
    const error = (r.error || 'The mail server did not accept the message').slice(0, 500);
    return { status: r.provablyNotSent === true ? 'failed' : 'unknown', messageId: null, error };
  } catch (err) {
    // A throw from the transport can come after the message was handed over: not provably unsent.
    log.error('Payslip email send threw', { error: err instanceof Error ? err.message : String(err) }, 'payslip-email');
    return { status: 'unknown', messageId: null, error: 'The send failed before the mail server answered' };
  }
}

export async function sendPayslipEmails(opts: {
  companyId: string; runId: string; employeeIds?: string[]; resend: boolean; actor: EmployeeEmailActor;
  mailer: Mailer; admit: (count: number) => Promise<boolean>; limits?: SendLimits;
}): Promise<PayslipEmailOutcome> {
  const { companyId, runId, resend, actor, mailer } = opts;
  const limits = opts.limits ?? SEND_LIMITS;
  const started = Date.now();
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
  const done = resend ? new Set<string>() : await alreadyDelivered(companyId, runId);

  const out: PayslipEmailOutcome = { sent: [], failed: [], uncertain: [], skipped: [], remaining: 0 };
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
  const batch = queue.slice(0, limits.maxSends);
  if (!(await opts.admit(batch.length))) {
    throw new PayslipEmailRefusal('RATE_LIMITED', 'Too many payslip emails for now. Try again later.');
  }

  const previous = await lastSentTo(companyId, batch.map((q) => q.slip.employeeId));
  let attempted = 0;
  for (const { slip, email, password } of batch) {
    if (attempted > 0 && Date.now() - started > limits.budgetMs) break;
    attempted += 1;
    const who = { employeeId: slip.employeeId, employeeNumber: slip.employeeNumber, employeeName: slip.employeeName };
    const { filename, pdf, sha256 } = await renderEmailPayslip(run, slip, password.password, approvedAt);
    const message = payslipEmailMessage(run, slip, password.source);
    const result = await deliver(mailer, {
      to: email, subject: message.subject, html: message.html,
      attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
      smtpTimeoutsMs: SMTP_TIMEOUTS_MS, deadlineMs: SEND_DEADLINE_MS,
    });
    await recordDelivery({ companyId, runId, employeeId: slip.employeeId, email, subject: message.subject, sha256, resend, actor, ...result });
    const before = previous.get(slip.employeeId);
    if (result.status === 'sent') out.sent.push({ ...who, sha256, addressChanged: before !== undefined && before !== email });
    else if (result.status === 'unknown') out.uncertain.push(who);
    else out.failed.push({ ...who, error: 'The mail server did not accept it. Check the address and try again.' });
  }
  out.remaining = queue.length - attempted;
  log.info('Payslips emailed', {
    companyId, runId, sent: out.sent.length, failed: out.failed.length, uncertain: out.uncertain.length, remaining: out.remaining,
  }, 'payslip-email');
  return out;
}
