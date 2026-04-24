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

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

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

  await sql`
    UPDATE payroll_run_headers
       SET status = 'calculated',
           updated_at = NOW()
     WHERE id = ${opts.runId}::uuid AND company_id = ${opts.companyId}::uuid
  `;

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
