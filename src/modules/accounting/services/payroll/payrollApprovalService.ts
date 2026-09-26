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
import { buildPayrollJournalPlan, type PayrollJournalNote } from './payrollJournalBuilder';

type Row = DbRow;

export interface ApprovePayrollRunResult extends PayrollRunSummary {
  journalEntryId: string;
}

/**
 * A refusal raised before approvePayrollRun writes anything. Callers answer it
 * as a 4xx; anything else may follow the status write and must roll back.
 */
export class PayrollApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollApprovalRefusedError';
  }
}

/**
 * The first reason this run's journal cannot post, judged before approval —
 * every plan blocker except 'run_not_approved', which approval itself
 * resolves. Null when the run is not in this company.
 */
export async function findApprovalBlocker(
  companyId: string,
  runId: string,
): Promise<PayrollJournalNote | null> {
  const plan = await buildPayrollJournalPlan(companyId, runId);
  if (!plan) return null;
  return plan.blockers.find((b) => b.code !== 'run_not_approved') ?? null;
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
 * (stranded before this fix) is re-approvable and posts.
 */
export async function approvePayrollRun(
  companyId: string,
  runId: string,
  userId: string,
  opts?: { postingAgent?: string },
): Promise<ApprovePayrollRunResult> {
  log.info('Approving payroll run', { companyId, runId }, 'payrollApproval');

  const runRows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (runRows.length === 0 || !runRows[0]) throw new PayrollApprovalRefusedError('Payroll run not found');

  const currentStatus = String(runRows[0].status);
  const APPROVABLE = ['draft', 'calculated', 'processed'];
  const alreadyApprovedButUnposted = currentStatus === 'approved' && runRows[0].journal_entry_id == null;
  if (!APPROVABLE.includes(currentStatus) && !alreadyApprovedButUnposted) {
    throw new PayrollApprovalRefusedError(
      `Cannot approve payroll run with status '${currentStatus}' ` +
      `(expected one of: ${APPROVABLE.join(', ')})`
    );
  }

  const blocker = await findApprovalBlocker(companyId, runId);
  if (blocker) throw new PayrollApprovalRefusedError(blocker.detail);

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
  };
}
