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
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  PayrollLoanLockTimeoutError,
  isLockTimeout,
  setLocalLockTimeout,
} from './payrollRunLoanApplication';

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
 * The run's header row, locked FOR UPDATE until the caller's transaction ends
 * — null when the run is not in this company. The wait is bounded at 5s, as
 * the loan lock is (applyRunLoans): a peer holding the row surfaces as the
 * retryable PayrollLoanLockTimeoutError instead of pinning the connection.
 *
 * In a savepoint (withTransaction), for two reasons. A 55P03 aborts whatever
 * (sub)transaction raised it; the callers answer this refusal as a 4xx / tool
 * error, which COMMITs / RELEASEs, so the abort must not reach their
 * transaction. And the savepoint rollback puts lock_timeout back by itself.
 * On success the savepoint is released, which keeps both the row lock and the
 * SET LOCAL — so the previous timeout is restored by hand, or the 5s would
 * bound every later statement of the request.
 */
export async function lockPayrollRunHeader(runId: string, companyId: string): Promise<DbRow | null> {
  return withTransaction(async (tx) => {
    const previousLockTimeout = await setLocalLockTimeout(tx, '5s');
    let rows: DbRow[];
    try {
      rows = (await tx`
        SELECT * FROM payroll_run_headers
        WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `) as DbRow[];
    } catch (err) {
      // No restore: the transaction is aborted and the savepoint rollback restores it.
      if (isLockTimeout(err)) throw new PayrollLoanLockTimeoutError(runId);
      throw err;
    }
    await setLocalLockTimeout(tx, previousLockTimeout);
    return rows[0] ?? null;
  });
}

export async function reopenPayrollRun(opts: {
  runId: string;
  companyId: string;
  userId: string;
  reason: string;
}): Promise<{ runId: string; previousStatus: string; newStatus: 'calculated' }> {
  const reason = opts.reason.trim();
  if (reason.length < 5) {
    throw new Error('Reopen reason is required (≥ 5 characters)');
  }

  const rows = (await sql`
    SELECT id, status FROM payroll_run_headers
     WHERE id = ${opts.runId}::uuid AND company_id = ${opts.companyId}::uuid
     LIMIT 1
  `) as DbRow[];
  if (rows.length === 0 || !rows[0]) throw new Error('Payroll run not found');

  const previousStatus = String(rows[0].status);
  if (!REOPENABLE_STATUSES.has(previousStatus)) {
    if (previousStatus === 'paid') {
      throw new Error('Paid runs cannot be reopened — payments have been issued. Reverse via a new run.');
    }
    if (previousStatus === 'cancelled') {
      throw new Error('Cancelled runs cannot be reopened — create a new run for this period.');
    }
    throw new Error(`Cannot reopen run in status '${previousStatus}' — only 'approved' is reopenable.`);
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
  if (!reopened[0]) throw new Error('Payroll run changed while it was being reopened — it is no longer approved.');

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
