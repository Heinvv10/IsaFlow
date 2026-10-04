/**
 * THE rule for "this bank line's cash is reconciled and must not move" — one
 * rule, three callers: single-payment void and batch reversal (through
 * `ap/paymentJournalReversal.ts`) and bank reverse (`reverseReconciledTransaction`).
 *
 * A line is locked only when a reconciliation's figures count it or completion
 * marked it: status 'reconciled' (completion wrote it, or the Sage import
 * `scripts/import-sage-britech.ts` did, with no reconciliation_id), or status
 * 'matched' on a reconciliation. The `reconciliation_id` stamp alone never
 * locks — start stamps every line it claims and allocation does not clear it.
 *
 * A completed reconciliation is reopened with `reopenReconciliation`
 * (bankReconciliationReopenService.ts, R-111, newest first); cancel still
 * refuses anything not in_progress. So the message names the reconciliation and
 * points at the reopen. Hein, 2026-09-21: lock now, reopen later; 2026-10-02:
 * "be able to reopen".
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ReconciliationCompletedError } from './reconciliationSessionLock';

/** Raised before any write; every caller answers it 400. A completed reconciliation is `ReconciliationCompletedError` (409, D12). */
export class ReconciledCashError extends Error {
  readonly code = 'RECONCILED_CASH';
  constructor(message: string) {
    super(message);
    this.name = 'ReconciledCashError';
  }
}

export type LineLock =
  | { kind: 'completed'; accountName: string | null; statementDate: unknown }
  | { kind: 'anomaly' }
  | { kind: 'sage' }
  | { kind: 'session' }
  | null;

/**
 * How a (locked) bank row stands against reconciliation. Reads only.
 *
 * Decided by what a reconciliation COUNTS and MARKS, never by the stamp alone:
 * `startReconciliation` stamps its id on the lines it claims
 * (bankReconciliationClaim.ts), and allocating a line later does not clear it.
 * Completion marks `reconciled` exactly what the session counts as matched —
 * `matched` lines and allocated lines self-matched to their own journal line
 * (2026-09-30). So: a `reconciled` line is locked (completion or the Sage
 * import wrote it); a `matched` line carrying a session's id is locked by that
 * session; an `allocated` line is not locked while its session is open — its
 * reversal is the remedy for a wrong allocation, it leaves the session with the
 * reversal, and completion recomputes the live GL balance before it signs off.
 * An allocated line carrying a COMPLETED session's stamp was not counted by it
 * (allocated after completion, or a pre-2026-09-30 session) and is not locked.
 */
export async function reconciliationLockOf(companyId: string, row: DbRow): Promise<LineLock> {
  const status = String(row.status ?? '');
  if (status !== 'reconciled' && status !== 'matched') return null;
  if (!row.reconciliation_id) return status === 'reconciled' ? { kind: 'sage' } : null;
  const rec = (await sql`
    SELECT r.status, r.statement_date, a.account_name
    FROM bank_reconciliations r
    LEFT JOIN gl_accounts a ON a.id = r.bank_account_id AND a.company_id = r.company_id
    WHERE r.id = ${String(row.reconciliation_id)}::UUID AND r.company_id = ${companyId}::UUID
  `) as DbRow[];
  const r = rec[0];
  if (r?.status === 'completed') {
    // A `matched` line on a COMPLETED reconciliation cannot come from
    // completion (it converts matched → reconciled in the same transaction),
    // but `matchTransaction` accepted any reconciliation id until D12; fail closed.
    return { kind: 'completed', accountName: r.account_name ? String(r.account_name) : null, statementDate: r.statement_date };
  }
  // 'reconciled' by name on a reconciliation that is NOT completed: an anomaly
  // (only completion writes that status) — locked, with its own message.
  if (status === 'reconciled') return { kind: 'anomaly' };
  return { kind: 'session' };
}

/**
 * Refuse a line whose cash a reconciliation holds. `subject` reads "This
 * payment's bank line" or "This bank line". The same for every caller: a
 * completed reconciliation is locked until it is reopened (R-111) — D12: the ONE
 * `ReconciliationCompletedError`, 409 at every route — a Sage one for good; a line in
 * an IN-PROGRESS session is refused too, because reversing or unmatching it
 * detaches it and leaves the session's stored difference stale — the remedy
 * exists there (the reconciliation screen's Unmatch, or cancel the session).
 */
export function refuseLockedCash(lock: LineLock, subject: string): void {
  if (lock?.kind === 'completed') throw new ReconciliationCompletedError(lock);
  if (lock?.kind === 'anomaly') {
    throw new ReconciledCashError(`${subject} is marked reconciled on a reconciliation that isn't completed. `
      + "That shouldn't happen, so contact support.");
  }
  if (lock?.kind === 'sage') {
    throw new ReconciledCashError(`${subject} was reconciled in the Sage import (no reconciliation in this app `
      + "holds it), so this can't be reversed in the app. Correct it with a journal, or contact support.");
  }
  if (lock?.kind === 'session') {
    throw new ReconciledCashError(`${subject} is in an open bank reconciliation session — remove it from that `
      + 'session (Unmatch on the reconciliation screen) or cancel the session first.');
  }
}
