/**
 * The journal plan a payroll run may post when no approval is in flight: the recovery posting (post_payroll_journal),
 * its dry run, and the poster when it is handed no plan.
 *
 * One function so the live call and the preview judge the same things in the same order (the repo's dry-run parity
 * rule): the plan is built, a plan blocked for a reason of its own is handed back to be refused with that reason, and
 * otherwise the run must be approved and its plan must hash to the one its approval described, so nobody posts a
 * journal that differs from the one a person approved (a mapping, account or cost-centre change since approval
 * refuses). The plan validated is the plan returned.
 *
 * LOCKS (payrollRunLock.ts order, 1 then 2): `lock: true` takes the company approval lock, then the run's header
 * row, both until the caller's transaction ends, and reads the plan under them. `lock: false` (a dry run) takes
 * none and reads the header unlocked; it writes nothing.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { buildPayrollJournalPlan, type PayrollJournalPlan } from './payrollJournalBuilder';
import { assertPayRunApproved } from './payRunApprovalControl';
import { matchesApprovedPlanHash } from './payrollApprovalHash';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader } from './payrollRunLock';

export const PLAN_CHANGED_SINCE_APPROVAL =
  'This payroll run no longer matches the journal plan that was approved. Reopen and re-approve it before posting.';

/**
 * Why a plan with ETI may have moved without anything on the run changing (wave 5 ET): the ETI it books is the month's
 * ETI used from the ETI ledger, which reads earlier months of the reconciliation period and this month's directive PAYE.
 */
export const ETI_CARRY_MAY_HAVE_CHANGED =
  'The ETI this journal books depends on the ETI brought forward from earlier months of the ETI period and on this month\'s '
  + 'directive PAYE (ETI Act s9(1)); one of those changed since approval, or the run was approved before ETI carry-forward was booked.';

/** The plan differs from the one approved. Raised before anything is written. */
export class PayrollPlanChangedSinceApprovalError extends Error {
  constructor(reason?: string) {
    super(reason ? `${PLAN_CHANGED_SINCE_APPROVAL} ${reason}` : PLAN_CHANGED_SINCE_APPROVAL);
    this.name = 'PayrollPlanChangedSinceApprovalError';
  }
}

/** The ETI reason, when this plan's ETI is not the run's own ETI capped at its PAYE (the carry or a directive moved it). */
function etiReason(plan: PayrollJournalPlan): string | undefined {
  const { eti, paye, etiUsed } = plan.totals;
  const runOnly = Math.round(Math.max(0, Math.min(eti, paye)) * 100);
  return Math.round(etiUsed * 100) !== runOnly || plan.advisories.some((a) => a.code === 'eti_brought_forward')
    ? ETI_CARRY_MAY_HAVE_CHANGED : undefined;
}

export interface ApprovedPlanRead {
  /** The run's header row, locked FOR UPDATE when `lock` was true. */
  header: DbRow;
  plan: PayrollJournalPlan;
}

/** null when the run is not in this company. Refuses (throws) when it is not approved or its plan changed since. */
export async function readApprovedPlan(
  companyId: string,
  runId: string,
  opts: { lock: boolean },
): Promise<ApprovedPlanRead | null> {
  let header: DbRow | null;
  if (opts.lock) {
    await lockCompanyPayrollApprovals(runId, companyId);
    header = await lockPayrollRunHeader(runId, companyId);
  } else {
    header = ((await sql`
      SELECT * FROM payroll_run_headers
      WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    `) as DbRow[])[0] ?? null;
  }
  if (!header) return null;
  const plan = await buildPayrollJournalPlan(companyId, runId);
  if (!plan) return null;
  // A plan blocked for a reason of its own (a loan above pay, a run to recalculate, a journal it already carries,
  // even on a reopened run) is refused with that reason by the caller, before any write: approval would not clear
  // it, so "not approved" would send a person the wrong way. An already-posted plan posts nothing (the poster
  // returns the link; the MCP tool reports already_posted).
  if (plan.blockers.some((b) => b.code !== 'run_not_approved')) return { header, plan };
  const clearance = await assertPayRunApproved(companyId, runId);
  if (clearance.grandfathered || plan.alreadyPostedJournalId) return { header, plan };
  const revision = header.approval_revision == null ? null : String(header.approval_revision);
  if (!clearance.planHash || !matchesApprovedPlanHash(plan, revision, clearance.planHash)) {
    throw new PayrollPlanChangedSinceApprovalError(etiReason(plan));
  }
  return { header, plan };
}
