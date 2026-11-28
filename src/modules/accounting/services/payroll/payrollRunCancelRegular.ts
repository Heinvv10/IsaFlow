/**
 * Cancelling a calculated regular pay run that was never approved (wave 7 CX, W28). Without it a regular run calculated
 * for the wrong period, or one the company decided not to pay, held its period (999a's regular-period key) and its
 * loan instalments for good: delete takes only never-calculated drafts (payrollRunDelete), reopen only approved runs.
 *
 * What a calculation wrote, and what cancel does with it (census of every table keyed to the run, in the PR body):
 *   payroll_loan_payments (449, run_id, ON DELETE SET NULL): this run's instalments are reversed exactly through
 *     payrollLoanReversal (schedule row unflagged, balance restored by what was taken, tombstone on
 *     payroll_loan_payment_reversals 621), under a FOR UPDATE of the loans in id order, as applyRunLoans locks them.
 *     A payment another run applied, or one stranded by a deleted run, is not this run's and is left alone.
 *   payroll_garnishee_deductions (999z, NO ACTION): recorded at calculate, unapplied until approval; dropped through
 *     releaseCancelledRunGarnishees, which resets any balance from what is counted (GT/GC2: total_debt -
 *     payroll_garnishee_order_counted). Cancel refuses a run with an applied deduction, so no balance moves.
 *   payroll_run_lines (382, CASCADE): deleted. Once-off amounts are employee components dated in the month, not rows
 *     of the run (payrollRunPeriodInputs), so a new run of the period reads them again.
 *   approval_requests (document_id, no FK): a pending request is withdrawn (rejected by the canceller, with its
 *     'declined' audit row), as the off-cycle cancel does.
 *   Approval-time rows (payroll_run_directive_uses 979, tax_directive_payments 901, payroll_bank_files 999h,
 *     payslip_deliveries 999o, the journal, an EMP201 naming the run): their presence refuses the cancel
 *     (payrollRunCancelEvidence), so none exists when the header goes.
 * Then the header is DELETED (coordinator ruling 2026-11-26): a 'cancelled' header would keep the regular-period key
 * (999a counts every status), so no new run of the period could be created, and a cancelled REGULAR run would be a state
 * no regular-run reader handles today. RH's 1054 delete rule admits a header with no approval evidence, which is the
 * only kind this reaches; nothing here bypasses a trigger. One audit_log row (action 'delete', metadata event
 * 'cancelled': the audit_log action CHECK has no 'cancel') carries the period, frequency, line count, totals and the
 * ids released, so the record outlives the header.
 *
 * Locks: the company payroll-approval lock, then the header (calculate and approve take both in this order), then the
 * request, then the loans. Every refusal is a 409 judged before the first write. Owner or admin, never under Login-as
 * (the route and assertNotImpersonating).
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader } from './payrollRunLock';
import { listReversibleLoanPayments, reverseLoanApplicationsForRun } from './payrollLoanReversal';
import { releaseCancelledRunGarnishees } from './payrollGarnisheeRun';
import { regularRunCancelRefusal } from './payrollRunCancelEvidence';
import { cancelOffCycleRun, withdrawPendingPayRunRequest } from './payrollRunCancel';
import { dateColumnOf } from './payrollFrequency';
import { isLockTimeout, PayrollLoanLockTimeoutError, setLocalLockTimeout } from './payrollLoanLock';
import { PAYROLL_REFUSAL } from './payrollRefusalCodes';
import type { PayrollRunSummary } from './payrollRunHeaders';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

/** A regular run that cannot be cancelled: 409 RUN_NOT_CANCELLABLE, nothing written. */
export class RunNotCancellableError extends Error {
  readonly code = PAYROLL_REFUSAL.RUN_NOT_CANCELLABLE;
  readonly status = 409;
  constructor(why: string) {
    super(`This pay run cannot be cancelled: ${why}. Only a calculated regular run that was never approved can be cancelled; `
      + 'correct an approved run by reopening it.');
    this.name = 'RunNotCancellableError';
  }
}

export interface RegularRunCancelled {
  runId: string;
  deleted: true;
  periodStart: string | null;
  payFrequency: string;
  lines: number;
  loanPaymentsReversed: number;
  garnisheeDeductionsDropped: number;
  approvalRequestWithdrawn: string | null;
}

const WITHDRAWN = 'Withdrawn: the pay run was cancelled.';

/** The loans this run's own instalments touched, locked FOR UPDATE in id order with a bounded wait (applyRunLoans' order). */
async function lockRunLoans(tx: TxSql, companyId: string, runId: string): Promise<void> {
  const previous = await setLocalLockTimeout(tx, '5s');
  try {
    await tx`
      SELECT l.id FROM payroll_loans l
       WHERE l.company_id = ${companyId}::uuid
         AND EXISTS (SELECT 1 FROM payroll_loan_payments p WHERE p.loan_id = l.id AND p.run_id = ${runId}::uuid)
       ORDER BY l.id
         FOR UPDATE
    `;
  } catch (err) {
    if (isLockTimeout(err)) throw new PayrollLoanLockTimeoutError(runId);
    throw err;
  }
  await setLocalLockTimeout(tx, previous);
}

/** Null when the run is not this company's. Throws RunNotCancellableError (409) before any write. */
export async function cancelRegularRun(companyId: string, runId: string, actor: EmployeeEmailActor): Promise<RegularRunCancelled | null> {
  await assertNotImpersonating(); // first, before any read or write
  await lockCompanyPayrollApprovals(runId, companyId);
  const run = await lockPayrollRunHeader(runId, companyId);
  if (!run) return null;
  if (run.run_kind !== 'regular') throw new RunNotCancellableError('it is not a regular run');
  if (run.status !== 'calculated') {
    throw new RunNotCancellableError(run.status === 'draft' ? 'it has not been calculated (delete the draft instead)' : `it is ${String(run.status)}`);
  }
  const why = await regularRunCancelRefusal(companyId, run);
  if (why) throw new RunNotCancellableError(why);

  return withTransaction(async (tx) => {
    await lockRunLoans(tx, companyId, runId);
    const payments = (await listReversibleLoanPayments(companyId, runId, Number(run.period_year), Number(run.period_month), tx))
      .filter((p) => p.runId === runId); // this run's own only; a payment stranded by a deleted run is not its to release
    const garnisheeIds = ((await tx`
      SELECT id::text AS id FROM payroll_garnishee_deductions WHERE run_id = ${runId}::uuid AND company_id = ${companyId}::uuid ORDER BY id
    `) as DbRow[]).map((r) => String(r.id));
    const lineCount = Number(((await tx`
      SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = ${runId}::uuid
    `) as DbRow[])[0]?.n ?? 0);

    const requestId = await withdrawPendingPayRunRequest(tx, companyId, runId, actor.userId, {
      note: WITHDRAWN, reason: 'pay run cancelled', planHash: run.approval_plan_hash,
    });
    await reverseLoanApplicationsForRun(companyId, runId, payments, tx);
    const garnishees = await releaseCancelledRunGarnishees(tx, companyId, runId);

    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'delete', entityType: 'payroll_run', entityId: runId,
      changes: {
        fields: [
          { field: 'status', old: String(run.status), new: null, label: 'Status' },
          { field: 'pay_frequency', old: String(run.pay_frequency), new: null, label: 'Pay frequency' },
          { field: 'period_start', old: dateColumnOf(run.period_start), new: null, label: 'Period start' },
        ],
        metadata: {
          event: 'cancelled',
          periodEnd: String(dateColumnOf(run.period_end)),
          lineCount: String(lineCount),
          employeeCount: String(Number(run.employee_count) || 0),
          totalGross: String(run.total_gross ?? 0),
          totalNet: String(run.total_net ?? 0),
          totalPaye: String(run.total_paye ?? 0),
          loanPaymentIds: JSON.stringify(payments.map((p) => p.paymentId)),
          loansRestored: JSON.stringify(payments.map((p) => ({ loanId: p.loanId, principal: p.principalPaid, interest: p.interestCharged }))),
          garnisheeDeductionIds: JSON.stringify(garnisheeIds),
          approvalRequestWithdrawn: requestId ?? '',
        },
      },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    }, tx);

    await tx`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid`;
    // Predicated on the state judged above (the header lock makes a miss unexpected): thrown, so the request rolls back.
    const gone = (await tx`
      DELETE FROM payroll_run_headers
       WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid AND status = 'calculated' AND run_kind = 'regular'
         AND approved_at IS NULL AND reopened_at IS NULL AND journal_entry_id IS NULL
       RETURNING id
    `) as DbRow[];
    if (!gone[0]) throw new Error('Pay run changed while it was being cancelled');
    log.info('Regular payroll run cancelled', {
      companyId, runId, userId: actor.userId, lines: lineCount, loanPayments: payments.length, garnishees, requestId,
    }, 'payrollRunCancelRegular');
    return {
      runId, deleted: true as const, periodStart: dateColumnOf(run.period_start), payFrequency: String(run.pay_frequency),
      lines: lineCount, loanPaymentsReversed: payments.length, garnisheeDeductionsDropped: garnishees, approvalRequestWithdrawn: requestId,
    };
  });
}

export type PayrollRunCancelResult =
  | { runKind: 'off_cycle'; run: PayrollRunSummary }
  | { runKind: 'regular'; cancelled: RegularRunCancelled };

/** The cancel route's one entry: an off-cycle run keeps its header as 'cancelled'; a regular one goes. Null: not found. */
export async function cancelPayrollRun(companyId: string, runId: string, actor: EmployeeEmailActor): Promise<PayrollRunCancelResult | null> {
  await assertNotImpersonating(); // R-032 L5: before even the kind is read (a Login-as session learns nothing)
  const kind = ((await sql`
    SELECT run_kind FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!kind) return null;
  if (kind.run_kind === 'regular') {
    const cancelled = await cancelRegularRun(companyId, runId, actor);
    return cancelled ? { runKind: 'regular', cancelled } : null;
  }
  // Every other kind keeps the off-cycle path, which refuses anything but an off-cycle run (unchanged).
  const run = await cancelOffCycleRun(companyId, runId, actor.userId);
  return run ? { runKind: 'off_cycle', run } : null;
}
