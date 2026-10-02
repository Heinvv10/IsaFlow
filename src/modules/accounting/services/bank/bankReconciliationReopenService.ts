/**
 * Bank Reconciliation Reopen Service (R-111)
 *
 * Returns a COMPLETED reconciliation to in_progress and its lines to the state
 * completion took them from, so a wrong allocation inside it can be reversed in
 * the app instead of patched with a hand journal. Hein, 2026-10-02: "be able to
 * reopen".
 *
 * ── WHAT COMPLETION DID, AND WHAT REOPEN UNDOES ─────────────────────────────
 *
 * Completion marks `reconciled` exactly what the session counted as matched:
 * `matched` lines (a person or auto-match paired them with an existing journal
 * line) and `allocated` lines self-matched to their own allocation journal line
 * (bankReconciliationClaim.ts). Both become `reconciled` and the distinction is
 * not stored — but `allocation_type` is: every allocation path (manual, rule
 * auto-post, split) writes it and matching never does. So a reconciled line on
 * this session goes back to `allocated` when it has an allocation_type, and to
 * `matched` when it does not. Lines keep `reconciliation_id` and their journal
 * link; the session is open again, so reconciledCash.ts treats an allocated line
 * as reversible (it leaves the session with its reversal) and a matched one as
 * held by the session (Unmatch, or cancel the session).
 *
 * ── NEWEST FIRST ─────────────────────────────────────────────────────────────
 *
 * Only the LATEST completed reconciliation on an account can be reopened. A
 * statement's opening balance is the previous one's closing balance; reopening
 * an older session under later completed ones would let a correction change a
 * balance that later sign-offs were made against, with those still reading
 * "completed". The refusal names how many later ones stand and the newest date.
 * An account with an in-progress session is refused too — two open sessions on
 * one account is the state perform_bank_reconciliation already refuses.
 *
 * Sage-imported `reconciled` lines carry no reconciliation_id and are never
 * touched. Adjustment journals stay as they are: the header is not deleted.
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface ReopenReconciliationOptions {
  /** Run every guard and report what WOULD change, writing nothing. */
  dryRun?: boolean;
  /** Why it is being reopened. Stored on the header as the audit record. */
  reason?: string;
}

export interface ReopenReconciliationResult {
  bankAccountId: string;
  statementDate: string;
  /** Reconciled lines returned to 'allocated' (self-matched allocations). */
  restoredAllocated: number;
  /** Reconciled lines returned to 'matched'. */
  restoredMatched: number;
}

/** Thrown when the reconciliation cannot be reopened as it stands. Caller-facing. */
export class ReconciliationNotReopenableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationNotReopenableError';
  }
}

function isoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export async function reopenReconciliation(
  companyId: string, id: string, userId: string,
  opts: ReopenReconciliationOptions = {},
): Promise<ReopenReconciliationResult> {
  const reconRows = (await sql`
    SELECT id, status, bank_account_id, statement_date, completed_at
    FROM bank_reconciliations
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const recon = reconRows[0];
  if (!recon) throw new ReconciliationNotReopenableError(`Reconciliation ${id} not found`);
  if (String(recon.status) !== 'completed') {
    throw new ReconciliationNotReopenableError(
      'Only a completed reconciliation can be reopened — an in-progress one is already open',
    );
  }
  const bankAccountId = String(recon.bank_account_id);
  const statementDate = isoDate(recon.statement_date);

  const later = (await sql`
    SELECT COUNT(*) AS cnt, MAX(statement_date) AS newest
    FROM bank_reconciliations
    WHERE company_id = ${companyId}::UUID
      AND bank_account_id = ${bankAccountId}::UUID
      AND status = 'completed'
      AND id <> ${id}::UUID
      AND (statement_date > ${statementDate}::DATE
        OR (statement_date = ${statementDate}::DATE AND completed_at > ${recon.completed_at}))`) as DbRow[];
  const laterCount = Number(later[0]?.cnt ?? 0);
  if (laterCount > 0) {
    throw new ReconciliationNotReopenableError(
      `Cannot reopen: ${laterCount} later completed reconciliation${laterCount === 1 ? '' : 's'} `
      + `on this account (newest to ${isoDate(later[0]!.newest)}) — reopen those first, newest first`,
    );
  }

  const open = (await sql`
    SELECT id FROM bank_reconciliations
    WHERE company_id = ${companyId}::UUID AND bank_account_id = ${bankAccountId}::UUID
      AND status = 'in_progress'`) as DbRow[];
  if (open.length > 0) {
    throw new ReconciliationNotReopenableError(
      `Cannot reopen: reconciliation ${String(open[0]!.id)} is already in progress on this account — `
      + 'complete or cancel it first',
    );
  }

  if (opts.dryRun) {
    const projected = (await sql`
      SELECT COUNT(*) FILTER (WHERE allocation_type IS NOT NULL) AS allocated,
             COUNT(*) FILTER (WHERE allocation_type IS NULL) AS matched
      FROM bank_transactions
      WHERE reconciliation_id = ${id}::UUID AND company_id = ${companyId}::UUID
        AND status = 'reconciled'`) as DbRow[];
    return {
      bankAccountId, statementDate,
      restoredAllocated: Number(projected[0]?.allocated ?? 0),
      restoredMatched: Number(projected[0]?.matched ?? 0),
    };
  }

  const reason = opts.reason?.trim() || null;
  const result = await withTransaction(async (tx) => {
    // Header first, with every guard re-asserted IN the statement: the reads
    // above ran outside this transaction, and a concurrent completion of a later
    // statement or a newly started session would otherwise slip through.
    const reopened = (await tx`
      UPDATE bank_reconciliations br
      SET status = 'in_progress', completed_by = NULL, completed_at = NULL,
          reopened_by = ${userId}::UUID, reopened_at = NOW(), reopen_reason = ${reason},
          updated_at = NOW()
      WHERE br.id = ${id}::UUID AND br.company_id = ${companyId}::UUID AND br.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM bank_reconciliations other
          WHERE other.company_id = br.company_id AND other.bank_account_id = br.bank_account_id
            AND other.id <> br.id
            AND (other.status = 'in_progress'
              OR (other.status = 'completed' AND (other.statement_date > br.statement_date
                OR (other.statement_date = br.statement_date AND other.completed_at > br.completed_at)))))
      RETURNING br.id`) as DbRow[];
    if (reopened.length === 0) {
      throw new ReconciliationNotReopenableError(
        'Reconciliation changed while reopening — a later one was completed or a session was '
        + 'started on this account. Reload and try again.',
      );
    }
    const restored = (await tx`
      UPDATE bank_transactions
      SET status = CASE WHEN allocation_type IS NOT NULL THEN 'allocated' ELSE 'matched' END,
          updated_at = NOW()
      WHERE reconciliation_id = ${id}::UUID AND company_id = ${companyId}::UUID
        AND status = 'reconciled'
      RETURNING status`) as DbRow[];
    return {
      restoredAllocated: restored.filter((r) => r.status === 'allocated').length,
      restoredMatched: restored.filter((r) => r.status === 'matched').length,
    };
  });

  log.info('Reopened bank reconciliation', {
    id, userId, bankAccountId, statementDate, reason, ...result,
  }, 'accounting');
  return { bankAccountId, statementDate, ...result };
}
