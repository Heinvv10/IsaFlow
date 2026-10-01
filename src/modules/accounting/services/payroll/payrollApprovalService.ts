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
import type { PayrollJournalNote, PayrollJournalPlan } from './payrollJournalBuilder';
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
 * its figures still match it (payrollApprovalGate). One whose journal was
 * reversed (and the reversal stands) is unlinked from it and posts a FRESH
 * journal, here, under the header lock.
 *
 * `expectedPlanHash` is the hash the caller previewed (mandatory on the HTTP
 * route and in the MCP tool's handler; optional here only for scripts). When given and
 * the run no longer hashes the same, approval is refused with
 * PayrollApprovalConflictError (409) before anything is written.
 *
 * The header row is locked FOR UPDATE first. calculatePayrollRun takes the
 * same lock before its status check, so the two serialise on the row: a
 * calculate already in flight finishes (and commits) before this gate reads
 * the run — the new figures then fail a stale hash — and a calculate arriving
 * after this approval commits reads 'approved' and refuses. calculate's own
 * header UPDATE is also predicated on an unlocked status.
 * Tests: tests/integration/w3-01-calculate-approve-race.int.test.ts.
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

  // A reversed journal is unlinked so a fresh one can post (breaker A). The
  // predicate repeats the gate's judgement in the write itself: the link goes
  // only while that journal is reversed and its reversal stands, so a run can
  // never be given a second journal beside a live one. Zero rows writes
  // nothing, so it is still a refusal.
  if (gate.replaces) {
    const unlinked = (await sql`
      UPDATE payroll_run_headers h
      SET journal_entry_id = NULL
      WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
        AND h.journal_entry_id = ${gate.replaces.journalEntryId}::uuid
        AND EXISTS (SELECT 1 FROM gl_journal_entries e
                     WHERE e.id = h.journal_entry_id AND e.company_id = h.company_id AND e.reversed_at IS NOT NULL)
        AND EXISTS (SELECT 1 FROM gl_journal_entries c
                     WHERE c.reversal_of_id = h.journal_entry_id AND c.company_id = h.company_id
                       AND c.status = 'posted' AND c.reversed_at IS NULL)
      RETURNING h.id
    `) as Row[];
    if (!unlinked[0]) throw new PayrollApprovalConflictError('Payroll run changed while you were reviewing it');
  }

  const updatedRows = (await sql`
    UPDATE payroll_run_headers
    SET status     = 'approved',
        updated_at = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];
  if (!updatedRows[0]) throw new Error('Status update returned no row');

  // The plan the gate judged and the hash described is the plan that posts —
  // the poster does not build its own (breaker D). Its blockers were judged
  // above; what remains on it ('run_not_approved', the unlinked journal) has
  // just been resolved by the two writes.
  const plan: PayrollJournalPlan = {
    ...gate.plan,
    status: 'approved',
    alreadyPostedJournalId: gate.posted?.journalEntryId ?? null,
    blockers: [],
  };

  // Idempotent — skips posting if journal_entry_id is already set.
  //
  // `opts` is forwarded so an automated caller can attribute its own posting.
  // Omitting it leaves the journal on `defaultHumanMeta(userId)`, which labels
  // agent work as the token owner's own and hides it from list_agent_postings —
  // the same reason postPayrollRunJournal takes the stamp at all.
  const journalEntryId = await postPayrollRunJournal(companyId, runId, userId, { postingAgent: opts?.postingAgent, plan });

  log.info('Payroll run approved and journal posted', { companyId, runId, journalEntryId }, 'payrollApproval');

  return {
    ...mapRunRow(updatedRows[0]),
    status: 'approved',
    journalEntryId,
    advisories: plan.advisories,
  };
}
