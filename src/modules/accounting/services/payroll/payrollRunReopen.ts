/**
 * Reopen an approved payroll run (split out of payrollRunLock.ts, a pure move). The lock order and the
 * rule for what may be reopened are documented at the top of payrollRunLock.ts.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  REOPENABLE_STATUSES,
  lockCompanyPayrollApprovals,
  lockPayrollRunHeader,
} from './payrollRunLock';
import { GRANDFATHERED_PLAN_HASH, recordPayRunApprovalAudit } from './payRunApprovalAudit';
import { lineRemunerationBeforeDeductionsSql } from './payrollLineRemuneration';
import type { DbRow } from '@/lib/neon';

/**
 * A refusal raised before reopenPayrollRun writes anything. The route answers
 * only this as a 400; anything else is a 500 and rolls the request back.
 */
export class PayrollRunReopenRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollRunReopenRefusedError';
  }
}

export async function reopenPayrollRun(opts: {
  runId: string;
  companyId: string;
  userId: string;
  reason: string;
}): Promise<{ runId: string; previousStatus: string; newStatus: 'calculated' }> {
  const reason = opts.reason.trim();
  if (reason.length < 5) {
    throw new PayrollRunReopenRefusedError('Reopen reason is required (≥ 5 characters)');
  }

  // Locked with the 5s wait approve and calculate use (round 5): the bare read
  // and UPDATE here waited on a peer's hold of the row for as long as it lasted.
  // The company approval lock first, in their order (see the top of this file).
  await lockCompanyPayrollApprovals(opts.runId, opts.companyId);
  const run = await lockPayrollRunHeader(opts.runId, opts.companyId);
  if (!run) throw new PayrollRunReopenRefusedError('Payroll run not found');

  const previousStatus = String(run.status);
  if (!REOPENABLE_STATUSES.has(previousStatus)) {
    if (previousStatus === 'paid') {
      throw new PayrollRunReopenRefusedError('Paid runs cannot be reopened — payments have been issued. Reverse via a new run.');
    }
    if (previousStatus === 'cancelled') {
      throw new PayrollRunReopenRefusedError('Cancelled runs cannot be reopened — create a new run for this period.');
    }
    throw new PayrollRunReopenRefusedError(`Cannot reopen run in status '${previousStatus}' — only 'approved' is reopenable.`);
  }

  // Predicated on the status just judged: a run that left 'approved' between
  // the read above and this write (paid, say) must not be reopened by it.
  // The approval it ends is kept as [approved_at, reopened_at) in
  // approval_history (migration 925), one clock reading for both, for the stale
  // year-to-date gate (payrollYearToDateGate#judgeYearToDate). If the clock
  // has stepped back past approved_at, the range would be inverted (an error):
  // it is empty instead, so that approval is not kept and the gate refuses a
  // month calculated during it conservatively (a recalculation clears it). Not
  // LEAST(): it skips a NULL approved_at (pre-718), whose range is unbounded below.
  const reopened = (await sql`
    UPDATE payroll_run_headers h
       SET status = 'calculated',
           approved_by = NULL,          -- no longer approved; lines_confirmed_at stays (migration 718)
           approved_at = NULL,
           approval_grandfathered_at = NULL,
           approval_plan_hash = NULL,
           payslips_final_at = NULL,    -- payslips are DRAFT again (migration 968)
           payslips_final_by = NULL,
           approval_revision = gen_random_uuid(),
           reopened_at = c.now,
           approval_history = COALESCE(h.approval_history, '{}'::tstzmultirange)
             + tstzmultirange(tstzrange(CASE WHEN h.approved_at > c.now THEN c.now ELSE h.approved_at END, c.now, '[)')),
           -- Whom the approval it ends taxed from the tables, added to every earlier one's (migration 925).
           -- Unknown stays unknown: a history with no set was reopened before the column existed.
           approved_taxed_employees = CASE WHEN h.approval_history IS NOT NULL AND h.approved_taxed_employees IS NULL THEN NULL
             ELSE ARRAY(SELECT DISTINCT u FROM unnest(COALESCE(h.approved_taxed_employees, '{}'::uuid[]) || ARRAY(
               SELECT l.employee_id
               FROM payroll_run_lines l
               CROSS JOIN LATERAL (${lineRemunerationBeforeDeductionsSql()}) r
               WHERE l.run_id = h.id
                 AND r.had_table_remuneration)) u ORDER BY u) END,
           updated_at = NOW()
      FROM (SELECT clock_timestamp() AS now) c
     WHERE h.id = ${opts.runId}::uuid AND h.company_id = ${opts.companyId}::uuid
       AND h.status = 'approved'
     RETURNING h.id
  `) as DbRow[];
  if (!reopened[0]) throw new PayrollRunReopenRefusedError('Payroll run changed while it was being reopened — it is no longer approved.');

  const reviewedHash = run.approved_plan_hash == null ? GRANDFATHERED_PLAN_HASH : String(run.approved_plan_hash);
  await recordPayRunApprovalAudit({
    companyId: opts.companyId, runId: opts.runId, actorId: opts.userId,
    event: 'reopened', planHash: reviewedHash, metadata: { reason },
  });

  log.info(
    'Payroll run reopened',
    {
      companyId: opts.companyId,
      runId: opts.runId,
      userId: opts.userId,
      previousStatus,
      reason,
    },
    'payrollRunLock',
  );

  return { runId: opts.runId, previousStatus, newStatus: 'calculated' };
}
