/**
 * Payroll Approval Service
 * Transitions a payroll run to 'approved' and posts its GL journal entry.
 *
 * Separated from payrollRunService.ts to keep files under 300 lines.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { mapRunRow, type PayrollRunSummary } from './payrollRunService';
import { postPayrollRunJournal } from './payrollJournalPostingService';
import { PayrollApprovalConflictError, PayrollApprovalRefusedError } from './payrollApprovalRefusal';
import type { PayrollJournalNote, PayrollJournalPlan } from './payrollJournalBuilder';
import { judgePayrollApproval, type PayrollApprovalGate } from './payrollApprovalGate';
import { lockCompanyPayrollApprovals, lockPayrollRunHeader, lockRunJournalForApproval } from './payrollRunLock';
import { claimRunSeveranceDirectives } from './payrollRunDirectiveClaim';
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
 * its figures still match it (payrollApprovalGate). One whose journal has
 * nothing left in the ledger (its reversal chain nets to zero) is unlinked
 * from it and posts a FRESH journal, here, under the locks.
 *
 * `expectedPlanHash` is the hash the caller previewed (mandatory on the HTTP
 * route and in the MCP tool's handler; optional here only for scripts). When given and
 * the run no longer hashes the same, approval is refused with
 * PayrollApprovalConflictError (409) before anything is written.
 *
 * The header row is locked FOR UPDATE first (5s wait, then
 * PayrollLoanLockTimeoutError — nothing written; the route answers 400, the
 * MCP tool a tool error), then the linked journal and its reversal.
 * calculatePayrollRun takes the same header lock before its status check, so the two serialise on the row: a
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

  // The company's approval lock (other runs' termination pay-outs, which the
  // gate reads), then the header, then the journal it links and that journal's
  // whole reversal chain — in that order, each with a 5s wait
  // (payrollJournalChain). The gate below reads them inside these locks, so
  // what it judges cannot change before the writes, and the generic reversal
  // takes the same row locks.
  await lockCompanyPayrollApprovals(runId, companyId);
  const locked = await lockPayrollRunHeader(runId, companyId);
  if (!locked) throw new PayrollApprovalRefusedError('Payroll run not found');
  if (locked.journal_entry_id != null) {
    await lockRunJournalForApproval(runId, companyId, String(locked.journal_entry_id));
  }

  const gate = await judgePayrollApproval(companyId, runId);
  if (!gate) throw new PayrollApprovalRefusedError('Payroll run not found');
  if (gate.blocker) throw new PayrollApprovalRefusedError(gate.blocker.detail);
  if (opts?.expectedPlanHash !== undefined && opts.expectedPlanHash !== gate.planHash) {
    throw new PayrollApprovalConflictError('Payroll run changed while you were reviewing it');
  }

  // The two writes a refusal may still follow, in ONE savepoint, so a refusal
  // from either leaves neither behind, whoever catches it (the MCP tool catches
  // it as a tool error, which releases its savepoint and commits):
  //  - the severance directives the run pays become its own
  //    (payrollRunDirectiveClaim), refused if a peer paid one meanwhile;
  //  - a journal with nothing left in the ledger is unlinked so a fresh one can
  //    post. The header and the whole chain are locked and the gate judged the
  //    chain inside those locks, so this cannot have changed; the predicate
  //    only refuses to drop a link other than the one judged.
  await withTransaction(async (tx) => {
    await claimRunSeveranceDirectives(companyId, runId, userId);
    if (gate.replaces) {
      const unlinked = (await tx`
        UPDATE payroll_run_headers
        SET journal_entry_id = NULL
        WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
          AND journal_entry_id = ${gate.replaces.journalEntryId}::uuid
        RETURNING id
      `) as Row[];
      if (!unlinked[0]) throw new PayrollApprovalConflictError('Payroll run changed while you were reviewing it');
    }
  });

  // lines_confirmed_at is the CLOCK, not the transaction's start (rounds 6–7,
  // breaker P2-A): the moment the run's lines were last confirmed to match its
  // journal, taken under the header lock, so it is later than any line a
  // calculation that finished before this approval wrote — even one this
  // approval waited behind. runRecalculatedSince compares lines against it. A
  // reopen clears approved_by/approved_at but keeps it (migration 718).
  const updatedRows = (await sql`
    UPDATE payroll_run_headers
    SET status      = 'approved',
        approved_by = ${userId}::uuid,
        approved_at = clock_timestamp(),
        lines_confirmed_at = clock_timestamp(),
        updated_at  = NOW()
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
