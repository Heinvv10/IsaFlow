/**
 * THE rule for "this bank line's cash is reconciled and must not move" — one
 * rule, three callers: single-payment void and batch reversal (through
 * `ap/paymentJournalReversal.ts`) and bank reverse (`reverseReconciledTransaction`).
 *
 * A line is locked when it is on a COMPLETED bank reconciliation — status
 * 'reconciled' (in src/ only `completeReconciliation` writes it) or a
 * `reconciliation_id` naming a `bank_reconciliations` row in `completed` — or
 * when it arrived already reconciled from the Sage import
 * (`scripts/import-sage-britech.ts` writes 'reconciled' with no
 * reconciliation_id: the cash was reconciled at source).
 *
 * Nothing in the app reopens or cancels a completed reconciliation yet
 * (`cancelReconciliation` refuses anything not in_progress) — R-111. So the
 * message says the true thing, names the reconciliation, and points at no path
 * that does not exist. Hein, 2026-09-21: lock now, reopen later.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** Raised before any write; every caller answers it 400. */
export class ReconciledCashError extends Error {
  readonly code = 'RECONCILED_CASH';
  constructor(message: string) {
    super(message);
    this.name = 'ReconciledCashError';
  }
}

export type LineLock =
  | { kind: 'completed'; reconciliation: string }
  | { kind: 'sage' }
  | { kind: 'session' }
  | null;

/** How a (locked) bank row stands against reconciliation. Reads only. */
export async function reconciliationLockOf(companyId: string, row: DbRow): Promise<LineLock> {
  if (row.reconciliation_id) {
    const rec = (await sql`
      SELECT r.status, r.statement_date, a.account_name
      FROM bank_reconciliations r
      LEFT JOIN gl_accounts a ON a.id = r.bank_account_id AND a.company_id = r.company_id
      WHERE r.id = ${String(row.reconciliation_id)}::UUID AND r.company_id = ${companyId}::UUID
    `) as DbRow[];
    const r = rec[0];
    if (row.status === 'reconciled' || r?.status === 'completed') {
      const account = r?.account_name ? String(r.account_name) : 'the bank account';
      const date = r?.statement_date ? fmtDate(r.statement_date) : 'an unknown date';
      // 'reconciled' by name on a session that is NOT completed is an anomaly
      // (only completion writes that status); it is locked all the same, and
      // the message says what it actually is rather than calling it completed.
      const where = r?.status === 'completed'
        ? `on the completed reconciliation of ${account} to ${date}`
        : `marked reconciled on the reconciliation of ${account} to ${date}, which is not completed`;
      return { kind: 'completed', reconciliation: where };
    }
    return { kind: 'session' };
  }
  return row.status === 'reconciled' ? { kind: 'sage' } : null;
}

const TAIL = "can't be reopened yet, so this can't be reversed in the app. Correct it with a journal, or contact support.";

/**
 * Refuse a completed-reconciliation or Sage-reconciled line. `subject` reads
 * "This payment's bank line" or "This bank line". An open session is NOT
 * refused here: void and batch reversal refuse it themselves; bank reverse does not.
 */
export function refuseLockedCash(lock: LineLock, subject: string): void {
  if (lock?.kind === 'completed') {
    throw new ReconciledCashError(
      `${subject} is ${lock.reconciliation}. A completed reconciliation ${TAIL}`);
  }
  if (lock?.kind === 'sage') {
    throw new ReconciledCashError(`${subject} was reconciled in the Sage import (no reconciliation in this app `
      + "holds it), so this can't be reversed in the app. Correct it with a journal, or contact support.");
  }
}
