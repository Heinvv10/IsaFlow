/**
 * Payroll-run lock primitives.
 *
 * A run is "locked" when its status is in LOCKED_STATUSES — at that point
 * recalculation, line edits, and approve/cancel transitions all reject.
 * The only way out of a locked state is reopenPayrollRun(), which:
 *   • requires a non-empty reason (audited)
 *   • only allows approved → calculated
 *   • paid runs cannot be reopened (money has moved — needs a reversing run)
 *   • cancelled runs cannot be reopened (create a new run instead)
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  PayrollLoanLockTimeoutError,
  isLockTimeout,
  setLocalLockTimeout,
} from './payrollRunLoanApplication';
import { lockJournalChain } from './payrollJournalChain';

export type PayrollRunStatus = 'draft' | 'calculated' | 'approved' | 'paid' | 'cancelled';

const LOCKED_STATUSES = new Set<string>(['approved', 'paid', 'cancelled']);
const REOPENABLE_STATUSES = new Set<string>(['approved']);

export function isPayrollRunLocked(status: string): boolean {
  return LOCKED_STATUSES.has(status);
}

export class PayrollRunLockedError extends Error {
  readonly status: string;
  constructor(status: string) {
    super(
      status === 'paid'
        ? 'Payroll run is paid — payments have been issued. Reverse via a new run.'
        : status === 'cancelled'
        ? 'Payroll run is cancelled — create a new run for this period.'
        : `Payroll run is ${status} (locked). Reopen it first if you need to edit.`
    );
    this.name = 'PayrollRunLockedError';
    this.status = status;
  }
}

/**
 * Take row locks with a 5s budget: a peer holding the row surfaces as the
 * retryable PayrollLoanLockTimeoutError (as the loan lock does, applyRunLoans)
 * instead of pinning the connection.
 *
 * In a savepoint (withTransaction), for two reasons. A 55P03 aborts whatever
 * (sub)transaction raised it; the callers answer this refusal as a 4xx / tool
 * error, which COMMITs / RELEASEs, so the abort must not reach their
 * transaction. And the savepoint rollback puts lock_timeout back by itself.
 * On success the savepoint is released, which keeps both the row locks and the
 * SET LOCAL — so the previous timeout is restored by hand, or the 5s would
 * bound every later statement of the request.
 */
export async function withBoundedLockWait<T>(runId: string, take: (tx: TxSql) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => {
    const previousLockTimeout = await setLocalLockTimeout(tx, '5s');
    let taken: T;
    try {
      taken = await take(tx);
    } catch (err) {
      // No restore: the transaction is aborted and the savepoint rollback restores it.
      if (isLockTimeout(err)) throw new PayrollLoanLockTimeoutError(runId);
      throw err;
    }
    await setLocalLockTimeout(tx, previousLockTimeout);
    return taken;
  });
}

/**
 * The run's header row, locked FOR UPDATE until the caller's transaction ends
 * — null when the run is not in this company. Taken by calculatePayrollRun and
 * approvePayrollRun before either reads the status, so the two serialise
 * (W3-01, BRK-596 R2-2): an approve arriving mid-calculation waits, then
 * judges the new figures; one that got there first makes the calculation read
 * 'approved' and refuse. Unlocked, an approve that committed between
 * calculate's status check and its header UPDATE was silently undone — back
 * to 'calculated', new totals, old journal. The wait is bounded
 * (withBoundedLockWait) and nothing is written before it.
 */
export async function lockPayrollRunHeader(runId: string, companyId: string): Promise<DbRow | null> {
  return withBoundedLockWait(runId, async (tx) => ((await tx`
    SELECT * FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    FOR UPDATE
  `) as DbRow[])[0] ?? null);
}

/**
 * Lock the journal a run links and its whole reversal chain, so approval
 * judges it on rows no one can change under it. Call under the header lock and
 * BEFORE the gate reads the chain. Order and reasoning: payrollJournalChain.
 */
export async function lockRunJournalForApproval(runId: string, companyId: string, journalId: string): Promise<void> {
  await withBoundedLockWait(runId, (tx) => lockJournalChain(tx, companyId, journalId));
}

/** The header figures calculatePayrollRun saves. */
export interface CalculatedRunTotals {
  gross: number; paye: number; uif: number; sdl: number; eti: number; net: number; employeeCount: number;
}

/**
 * Save a calculation's totals and mark the run 'calculated' — unless it has
 * been locked since calculatePayrollRun checked.
 *
 * Under a request transaction (withAuth, the MCP registry) the header lock is
 * held to the end of it, so no peer can have changed the status and the
 * predicate always matches. A caller with NO transaction open (the seed and
 * simulation scripts) keeps that lock only for its own statement: there the
 * predicate is what stops an approve committed meanwhile from being reverted
 * under its posted journal — and the run lines calculate rewrote are ALREADY
 * committed, so the message cannot promise otherwise. A plain Error, not a
 * refusal: under a request it is a 500 and rolls back (withAuth COMMITs a 4xx).
 * Test: tests/integration/w3-01-calculate-approve-race.int.test.ts.
 */
export async function saveCalculatedRunTotals(runId: string, companyId: string, t: CalculatedRunTotals): Promise<DbRow> {
  const updated = (await sql`
    UPDATE payroll_run_headers SET
      status         = 'calculated',
      total_gross    = ${t.gross},
      total_taxable  = ${t.gross},
      total_paye     = ${t.paye},
      total_uif      = ${t.uif},
      total_sdl      = ${t.sdl},
      total_eti      = ${t.eti},
      total_net      = ${t.net},
      employee_count = ${t.employeeCount},
      updated_at     = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
      AND status NOT IN ('approved', 'paid', 'cancelled')
    RETURNING *
  `) as DbRow[];
  if (!updated[0]) throw new Error('Payroll run was locked while it was being calculated — its totals were not saved');
  return updated[0];
}

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
  const reopened = (await sql`
    UPDATE payroll_run_headers
       SET status = 'calculated',
           updated_at = NOW()
     WHERE id = ${opts.runId}::uuid AND company_id = ${opts.companyId}::uuid
       AND status = 'approved'
     RETURNING id
  `) as DbRow[];
  if (!reopened[0]) throw new PayrollRunReopenRefusedError('Payroll run changed while it was being reopened — it is no longer approved.');

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
