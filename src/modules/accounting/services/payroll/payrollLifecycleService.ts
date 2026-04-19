/**
 * Payroll Run Lifecycle Service
 *
 * Implements the payroll run state machine:
 *   calculated → approved  (posts GL journal entry)
 *   approved   → paid      (stamps paid_at)
 *   draft | calculated | approved → cancelled  (reverses GL if was approved)
 *   paid       → *        (terminal — immutable)
 *   cancelled  → *        (terminal — immutable)
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getPayrollRun, type PayrollRunSummary } from './payrollRunService';
import { postPayrollRunToGL } from './payrollGlPostingService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

type Row = DbRow;

// ---------------------------------------------------------------------------
// approvePayrollRun — calculated → approved
// ---------------------------------------------------------------------------
export async function approvePayrollRun(
  companyId: string,
  userId: string,
  runId: string,
): Promise<PayrollRunSummary> {
  log.info('Approving payroll run', { companyId, runId }, 'payrollLifecycleService');

  const run = await getPayrollRun(runId, companyId);
  if (!run) throw new Error(`Payroll run ${runId} not found`);

  if (run.status !== 'calculated') {
    throw new Error(`Cannot approve run with status: ${run.status}`);
  }

  // Side effect FIRST: post GL. If this throws, we skip the UPDATE.
  await postPayrollRunToGL(companyId, userId, runId);

  await sql`
    UPDATE payroll_run_headers
    SET status      = 'approved',
        approved_by = ${userId}::uuid,
        approved_at = NOW(),
        updated_at  = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;

  const updated = await getPayrollRun(runId, companyId);
  if (!updated) throw new Error('Updated run not found');
  return updated;
}

// ---------------------------------------------------------------------------
// markPaid — approved → paid
// ---------------------------------------------------------------------------
export async function markPaid(
  companyId: string,
  userId: string,
  runId: string,
): Promise<PayrollRunSummary> {
  log.info('Marking payroll run as paid', { companyId, runId }, 'payrollLifecycleService');

  const run = await getPayrollRun(runId, companyId);
  if (!run) throw new Error(`Payroll run ${runId} not found`);

  if (run.status !== 'approved') {
    throw new Error(`Cannot mark paid run with status: ${run.status}`);
  }

  await sql`
    UPDATE payroll_run_headers
    SET status     = 'paid',
        paid_at    = NOW(),
        updated_at = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;

  // userId is referenced to satisfy the no-unused-params lint rule while
  // keeping the function signature consistent with the other lifecycle fns.
  void userId;

  const updated = await getPayrollRun(runId, companyId);
  if (!updated) throw new Error('Updated run not found');
  return updated;
}

// ---------------------------------------------------------------------------
// cancelPayrollRun — draft | calculated | approved → cancelled
// ---------------------------------------------------------------------------
export async function cancelPayrollRun(
  companyId: string,
  userId: string,
  runId: string,
): Promise<PayrollRunSummary> {
  log.info('Cancelling payroll run', { companyId, runId }, 'payrollLifecycleService');

  const run = await getPayrollRun(runId, companyId);
  if (!run) throw new Error(`Payroll run ${runId} not found`);

  const cancellable = ['draft', 'calculated', 'approved'] as const;
  if (!(cancellable as readonly string[]).includes(run.status)) {
    throw new Error(`Cannot cancel run with status: ${run.status}`);
  }

  // Reverse the GL journal entry only if the run was approved (i.e. a JE exists).
  if (run.status === 'approved') {
    const rows = (await sql`
      SELECT posted_journal_entry_id FROM payroll_run_headers
      WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    `) as Row[];
    const jeId = rows[0]?.posted_journal_entry_id;
    if (jeId) {
      await reverseJournalEntry(companyId, String(jeId), userId);
    }
  }

  await sql`
    UPDATE payroll_run_headers
    SET status                  = 'cancelled',
        cancelled_by            = ${userId}::uuid,
        cancelled_at            = NOW(),
        posted_journal_entry_id = NULL,
        updated_at              = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;

  const updated = await getPayrollRun(runId, companyId);
  if (!updated) throw new Error('Updated run not found');
  return updated;
}
