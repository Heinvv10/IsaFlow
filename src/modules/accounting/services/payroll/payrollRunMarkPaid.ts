/**
 * "Mark paid" (wave 7 MP, W27; Hein rulings 4 and 16, 2026-11-25): an explicit action moves an approved pay run to
 * `paid`, recording who and when (migration 1053: paid_by, paid_at) and the payment (paid_reference, paid_on). It needs
 * EITHER a confirmed salary bank file paying exactly the run (paid_on = the file's action date, no reference) OR a typed
 * bank payment reference + payment date. A paid run cannot be reopened (reopenPayrollRun: 409 RUN_PAID), approved,
 * recalculated or given a bank file; corrections go through an off-cycle run.
 *
 * Every refusal is judged before the one write (spec rule 12), in this order: Login-as (403), the typed input's shape,
 * then under the company approval lock and the run header lock (the order of payrollRunLock.ts, as reopen takes them):
 * the run (this company's; `paid` already = ALREADY_PAID; anything but `approved` = NOT_APPROVED; no approval time =
 * NOT_FINAL), the run's own journal posted and in force (grill F2), no salary bank file left `generated`, then the
 * path's evidence (payrollRunMarkPaidJudge). The writes after that: the header UPDATE (predicated on `approved`), then
 * one audit_log row.
 *
 * No run-kind guard: only an approved run is marked paid, and approval already passed it (payrollRunKindGuard); this
 * costs, posts and prints nothing. Nothing posts to the ledger: the payroll journal credited the bank (or net-pay
 * clearing) at approval.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { todayInSast } from '@/lib/saDateParser';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader } from './payrollRunLock';
import {
  PayrollRunMarkPaidRefusal, judgeBankFileEvidence, judgeNoUnsettledFile, judgePaidOnWindow, judgeRunJournal, parseTypedPayment,
} from './payrollRunMarkPaidJudge';

export interface MarkPaidActor {
  userId: string;
  userEmail?: string;
  ip?: string;
  userAgent?: string;
  sessionId?: string | null;
}

export interface MarkedPaid {
  runId: string;
  status: 'paid';
  /** How the payment was evidenced. */
  evidence: 'bank_file' | 'reference';
  paidAt: string;
  paidBy: string | null;
  paidReference: string | null;
  paidOn: string;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function markPayrollRunPaid(opts: {
  companyId: string; runId: string; actor: MarkPaidActor; reference?: string | null; paidOn?: string | null;
}): Promise<MarkedPaid> {
  const { companyId, runId, actor } = opts;
  await assertNotImpersonating();
  const typed = parseTypedPayment({ reference: opts.reference, paidOn: opts.paidOn });

  await lockCompanyPayrollApprovals(runId, companyId);
  const run = await lockPayrollRunHeader(runId, companyId);
  if (!run) throw new PayrollRunMarkPaidRefusal('NOT_FOUND', 'Payroll run not found');
  judgeStatus(run);
  const { approvedOn } = await judgeRunJournal(companyId, run);
  await judgeNoUnsettledFile(companyId, runId);
  const today = todayInSast();
  let evidence: { reference: string | null; paidOn: string; fileId: string | null; sha256: string | null };
  if (typed) {
    judgePaidOnWindow(typed.paidOn, approvedOn, today);
    evidence = { reference: typed.reference, paidOn: typed.paidOn, fileId: null, sha256: null };
  } else {
    const file = await judgeBankFileEvidence(companyId, run, today);
    evidence = { reference: null, paidOn: file.paidOn, fileId: file.fileId, sha256: file.sha256 };
  }

  // The one header write, everything judged above. paid_at is the clock and paid_by the session user (trigger, 1053).
  const written = ((await sql`
    UPDATE payroll_run_headers
       SET status = 'paid', paid_by = ${actor.userId}, paid_reference = ${evidence.reference}, paid_on = ${evidence.paidOn}::date,
           updated_at = NOW()
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid AND status = 'approved'
     RETURNING paid_at, paid_by, paid_reference, paid_on::text AS paid_on
  `) as DbRow[])[0];
  // Under the header lock the status cannot have moved; a miss is a fault (500), which rolls the request back.
  if (!written) throw new Error('markPayrollRunPaid: the approved run was not updated under its lock');

  const path = typed ? 'reference' : 'bank_file';
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_run', entityId: runId,
    changes: {
      fields: [{ field: 'status', old: 'approved', new: 'paid', label: 'Status' }],
      metadata: {
        event: 'marked_paid', evidence: path, paidOn: evidence.paidOn,
        ...(evidence.reference ? { paidReference: evidence.reference } : {}),
        ...(evidence.fileId ? { bankFileId: evidence.fileId, bankFileSha256: evidence.sha256 ?? '' } : {}),
      },
    },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  log.info('Payroll run marked paid', { companyId, runId, userId: actor.userId, evidence: path, paidOn: evidence.paidOn }, 'payrollRunMarkPaid');

  return {
    runId, status: 'paid', evidence: path, paidAt: iso(written.paid_at),
    paidBy: written.paid_by == null ? null : String(written.paid_by),
    paidReference: written.paid_reference == null ? null : String(written.paid_reference), paidOn: String(written.paid_on),
  };
}

function judgeStatus(run: DbRow): void {
  const status = String(run.status);
  if (status === 'paid') {
    const on = run.paid_on == null ? '' : ` on ${String(run.paid_on)}`; // DATE reads as text (pgTypes)
    throw new PayrollRunMarkPaidRefusal('ALREADY_PAID', `This run is already marked paid${on}.`);
  }
  if (status !== 'approved') {
    throw new PayrollRunMarkPaidRefusal('NOT_APPROVED', `Only an approved pay run can be marked paid. This run is '${status}'.`);
  }
  if (run.approved_at == null && run.approval_grandfathered_at == null) {
    throw new PayrollRunMarkPaidRefusal('NOT_FINAL', 'This run has no approval on record, so it is not final. Approve it first.');
  }
}
