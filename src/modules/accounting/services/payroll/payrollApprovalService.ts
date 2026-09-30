/**
 * Payroll Approval Service
 * Transitions a payroll run to 'approved' and posts its GL journal entry.
 *
 * Separated from payrollRunService.ts to keep files under 300 lines.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { mapRunRow, type PayrollRunSummary } from './payrollRunService';
import { postPayrollRunJournal } from './payrollJournalPostingService';
import { PayrollApprovalConflictError, PayrollApprovalRefusedError } from './payrollApprovalRefusal';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import { judgePayrollApproval, type PayrollApprovalGate } from './payrollApprovalGate';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';

type Row = DbRow;

export { PayrollApprovalConflictError, PayrollApprovalRefusedError } from './payrollApprovalRefusal';

export interface ApprovePayrollRunResult extends PayrollRunSummary {
  journalEntryId: string;
  /** The journal plan's advisories (e.g. `eti_beyond_paye`), for the caller to show. */
  advisories: PayrollJournalNote[];
}

/**
 * The first reason approval would refuse this run — the approval gate's
 * blocker (payrollApprovalGate.ts), exactly what approvePayrollRun refuses
 * with. Null when the run is approvable or is not in this company.
 */
export async function findApprovalBlocker(
  companyId: string,
  runId: string,
): Promise<PayrollJournalNote | null> {
  return (await judgePayrollApproval(companyId, runId))?.blocker ?? null;
}

/**
 * What approving this run would do, for the confirmation a person reads
 * before approving: the journal plan (never re-derived by the caller), the
 * journal it already carries when reopened, the blocker approval would
 * refuse with, and the hash approval checks the preview against. Read-only.
 * Null when the run is not in this company.
 */
export async function previewPayrollApproval(companyId: string, runId: string): Promise<PayrollApprovalGate | null> {
  return judgePayrollApproval(companyId, runId);
}

/**
 * Approve a payroll run and post its GL journal entry.
 * Valid prior statuses: 'draft', 'calculated', 'processed'.
 *
 * The run transitions to 'approved' then the GL journal is created and posted.
 * Every refusal comes BEFORE the status write, as PayrollApprovalRefusedError
 * (K-079): withAuth commits a 4xx, so a journal blocker found after the write
 * left the run 'approved' with no journal. A failure after the write is thrown
 * as-is and must roll the request back. An 'approved' run with no journal
 * (stranded before this fix) is re-approvable and posts; a reopened run that
 * still carries its journal is re-approved onto that journal, but only while
 * its figures still match it (payrollApprovalGate).
 *
 * `expectedPlanHash` is the hash the caller previewed. When given and the run
 * no longer hashes the same, approval is refused with
 * PayrollApprovalConflictError (409) before anything is written. The header
 * row is locked first, so nothing can recalculate it between that check and
 * the post.
 */
export async function approvePayrollRun(
  companyId: string,
  runId: string,
  userId: string,
  opts?: { postingAgent?: string; expectedPlanHash?: string },
): Promise<ApprovePayrollRunResult> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  log.info('Approving payroll run', { companyId, runId }, 'payrollApproval');

  const locked = (await sql`
    SELECT id FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    FOR UPDATE
  `) as Row[];
  if (locked.length === 0) throw new PayrollApprovalRefusedError('Payroll run not found');

  const gate = await judgePayrollApproval(companyId, runId);
  if (!gate) throw new PayrollApprovalRefusedError('Payroll run not found');
  if (gate.blocker) throw new PayrollApprovalRefusedError(gate.blocker.detail);
  if (opts?.expectedPlanHash !== undefined && opts.expectedPlanHash !== gate.planHash) {
    throw new PayrollApprovalConflictError('Payroll run changed while you were reviewing it');
  }
  const plan = gate.plan;

  const updatedRows = (await sql`
    UPDATE payroll_run_headers
    SET status     = 'approved',
        updated_at = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];
  if (!updatedRows[0]) throw new Error('Status update returned no row');

  // Idempotent — skips posting if journal_entry_id is already set.
  //
  // `opts` is forwarded so an automated caller can attribute its own posting.
  // Omitting it leaves the journal on `defaultHumanMeta(userId)`, which labels
  // agent work as the token owner's own and hides it from list_agent_postings —
  // the same reason postPayrollRunJournal takes the stamp at all.
  const journalEntryId = await postPayrollRunJournal(companyId, runId, userId, opts);

  log.info('Payroll run approved and journal posted', { companyId, runId, journalEntryId }, 'payrollApproval');

  return {
    ...mapRunRow(updatedRows[0]),
    status: 'approved',
    journalEntryId,
    advisories: plan.advisories,
  };
}
