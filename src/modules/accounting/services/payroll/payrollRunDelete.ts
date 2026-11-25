/**
 * Deleting a draft pay run (wave 6 FQd; coordinator r3 ruling on #1575: cancel/delete for draft runs is FQd's). A run
 * created for the wrong week, or left behind when the pay week changed, would otherwise hold its period for good.
 *
 * Only a run that has paid nobody is deleted: status 'draft', never approved, never calculated (no line, no calculated_at), and no
 * approval request on it. Anything else is RunNotDeletableError (409, nothing written): a calculated run has written
 * loan payments, directive uses and inputs keyed to it, and a once-approved run is history. Judged under the company's
 * payroll-approval lock and the run's row lock (calculate and approve take both, in this order), so no calculation or
 * approval lands between the checks and the delete. One audit_log `delete` row.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader } from './payrollRunLock';
import { dateColumnOf } from './payrollFrequency';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export class RunNotDeletableError extends Error {
  readonly code = 'RUN_NOT_DELETABLE';
  constructor(why: string) {
    super(`This pay run cannot be deleted: ${why}. Only a draft that was never calculated or approved can be deleted.`);
    this.name = 'RunNotDeletableError';
  }
}

/** False when the run is not this company's. Throws RunNotDeletableError before any write. */
export async function deleteDraftPayrollRun(companyId: string, runId: string, actor: EmployeeEmailActor): Promise<boolean> {
  await lockCompanyPayrollApprovals(runId, companyId);
  const run = await lockPayrollRunHeader(runId, companyId);
  if (!run) return false;
  // Migration 1054 refuses deleting a run with any past-approval evidence; judged here first so the answer is a 409.
  const approvedBefore = run.approved_at != null || run.approval_grandfathered_at != null || run.ever_final_at != null
    || run.reopened_at != null;
  if (run.status !== 'draft' || approvedBefore) {
    throw new RunNotDeletableError(approvedBefore ? 'it has been approved' : `it is ${String(run.status)}`);
  }
  const used = (await sql`
    SELECT EXISTS (SELECT 1 FROM payroll_run_lines WHERE run_id = ${runId}::uuid) AS lines,
           EXISTS (SELECT 1 FROM approval_requests WHERE company_id = ${companyId}::uuid AND document_id = ${runId}::uuid) AS approval
  `) as DbRow[];
  // calculated_at too (review #1679 Codex M): a bonus amount edit removes a calculated run's lines and returns it to
  // draft, and what its calculation wrote stays keyed to it.
  if (used[0]?.lines === true || run.calculated_at != null) throw new RunNotDeletableError('it has been calculated');
  if (used[0]?.approval === true) throw new RunNotDeletableError('approval has been requested for it');
  await sql`
    DELETE FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid AND status = 'draft'
  `;
  await logAuditOrThrow({
    companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'delete', entityType: 'payroll_run', entityId: runId,
    changes: { fields: [
      { field: 'pay_frequency', old: String(run.pay_frequency), new: null, label: 'Pay frequency' },
      { field: 'period_start', old: dateColumnOf(run.period_start), new: null, label: 'Period start' },
    ] },
    ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
  });
  return true;
}
