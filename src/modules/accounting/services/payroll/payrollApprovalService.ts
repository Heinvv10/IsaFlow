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

type Row = DbRow;

export interface ApprovePayrollRunResult extends PayrollRunSummary {
  journalEntryId: string;
}

/**
 * Approve a payroll run and post its GL journal entry.
 * Valid prior statuses: 'draft', 'calculated', 'processed'.
 *
 * The run transitions to 'approved' then the GL journal is created and posted.
 * NOTE: The Neon http driver does not support SAVEPOINT across service calls,
 * so these are sequential operations. If the journal post fails after the status
 * update, the run stays 'approved' with no journal_entry_id — re-calling approve
 * is safe because postPayrollRunJournal is idempotent (skips if already posted).
 */
export async function approvePayrollRun(
  companyId: string,
  runId: string,
  userId: string,
): Promise<ApprovePayrollRunResult> {
  log.info('Approving payroll run', { companyId, runId }, 'payrollApproval');

  const runRows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (runRows.length === 0 || !runRows[0]) throw new Error('Payroll run not found');

  const currentStatus = String(runRows[0].status);
  const APPROVABLE = ['draft', 'calculated', 'processed'];
  const alreadyApprovedButUnposted = currentStatus === 'approved' && runRows[0].journal_entry_id == null;
  if (!APPROVABLE.includes(currentStatus) && !alreadyApprovedButUnposted) {
    throw new Error(
      `Cannot approve payroll run with status '${currentStatus}' ` +
      `(expected one of: ${APPROVABLE.join(', ')})`
    );
  }

  const updatedRows = (await sql`
    UPDATE payroll_run_headers
    SET status     = 'approved',
        updated_at = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];
  if (!updatedRows[0]) throw new Error('Status update returned no row');

  // Idempotent — skips posting if journal_entry_id is already set
  const journalEntryId = await postPayrollRunJournal(companyId, runId, userId);

  log.info('Payroll run approved and journal posted', { companyId, runId, journalEntryId }, 'payrollApproval');

  return {
    ...mapRunRow(updatedRows[0]),
    status: 'approved',
    journalEntryId,
  };
}
