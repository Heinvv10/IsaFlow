/**
 * D12 — a COMPLETED (signed-off) bank reconciliation is immutable (Hein, 2026-10-04). Any write that would add,
 * remove or change a line in it is REFUSED before its first write with `ReconciliationCompletedError` (409), and
 * writes nothing; `reopenReconciliation` (#606, mig 719) is the only way back.
 *
 * A line is IN session S when it carries S's id and is `reconciled` or `matched` (`reconciledCash.ts` already fails
 * closed on `matched`). The same id on an imported / allocated / provisional / excluded line is a STALE stamp —
 * `bankReconciliationClaim.ts` re-claims it — and writes to that line proceed.
 *
 * ── THE SESSION ROW SERIALISES THEM ────────────────────────────────────────
 *
 * Every line writer takes the session row FOR SHARE (writers must not serialise each other); every header change —
 * complete, cancel, reopen, adjustment — takes it FOR UPDATE, both under the 5 s row-lock budget, and the status is
 * read UNDER the lock. So a completion waits for every in-flight writer of its lines and then signs off the figures
 * they left, and a writer arriving during a completion waits and then sees `completed`.
 *
 * LOCK ORDER: session row -> bank line -> document -> journal head. `lockBankTransactionForUpdate` takes a line's
 * stamped session before the line, so no path takes a session after holding one of ITS lines. No path upgrades a
 * share to an update on a session another request can share: the one request that does both (the MCP
 * `perform_bank_reconciliation`: auto-match, then complete) does it on the session it INSERTed itself, which no other
 * transaction can see.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { fmtDate } from '@/lib/fmtDate';
import { isLockContention } from '../core/lockContention';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';

type Fragment = ReturnType<typeof sql>;

export interface ReconciliationSession {
  id: string;
  status: string;
  accountName: string | null;
  statementDate: unknown;
  bankAccountId: string;
  completedAt: unknown;
}

/** Raised before any write. Routes answer it 409 (`@/lib/apiReconciliationCompleted`); MCP tools a refusal. */
export class ReconciliationCompletedError extends Error {
  readonly code = 'RECONCILIATION_COMPLETED';
  constructor(session: Pick<ReconciliationSession, 'accountName' | 'statementDate'>) {
    const account = session.accountName ?? 'the bank account';
    const date = session.statementDate ? fmtDate(session.statementDate) : 'an unknown date';
    super(`The bank reconciliation of ${account} to ${date} is completed — reopen it first`);
    this.name = 'ReconciliationCompletedError';
  }
}

/** Structural, like `isBankTransactionLockTimeout`: a status decision must survive module mocking. */
export function isReconciliationCompleted(err: unknown): err is ReconciliationCompletedError {
  return err instanceof Error && (err as { code?: unknown }).code === 'RECONCILIATION_COMPLETED';
}

/** A session that is completed refuses the write. */
export function refuseCompletedSession(session: ReconciliationSession | null | undefined): void {
  if (session?.status === 'completed') throw new ReconciliationCompletedError(session);
}

const SESSION_SELECT = `SELECT r.id::TEXT AS id, r.status, r.statement_date, r.bank_account_id, r.completed_at, a.account_name
  FROM bank_reconciliations r
  LEFT JOIN gl_accounts a ON a.id = r.bank_account_id AND a.company_id = r.company_id`;

function toSession(row: DbRow): ReconciliationSession {
  return {
    id: String(row.id), status: String(row.status),
    accountName: row.account_name ? String(row.account_name) : null, statementDate: row.statement_date,
    bankAccountId: String(row.bank_account_id), completedAt: row.completed_at,
  };
}

function requestClient() {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error('A reconciliation session lock requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR SHARE is released immediately and locks nothing.');
  }
  return client;
}

/**
 * FOR SHARE, in id order, every session named by `where` ($1 = ids, $2 = company). Issued on the request client,
 * like the `lock_timeout` settings it runs between: it is a lock acquisition the line-lock helpers take on every
 * call, and keeping it off the `sql` path leaves their callers' query sequence unchanged. The caller bounds the wait.
 */
async function shareLock(where: string, ids: readonly string[], companyId: string): Promise<Map<string, ReconciliationSession>> {
  const res = (await requestClient().query(
    `${SESSION_SELECT} ${where} AND r.company_id = $2::UUID ORDER BY r.id FOR SHARE OF r`,
    [ids, companyId])) as { rows?: DbRow[] } | undefined;
  const sessions = new Map<string, ReconciliationSession>();
  for (const row of res?.rows ?? []) if (row.id) sessions.set(String(row.id), toSession(row));
  return sessions;
}

/**
 * The sessions the given bank lines are stamped with, peeked UNLOCKED and then locked FOR SHARE in id order — the
 * first step of every bank-line lock (`bankTxLock`). The caller locks the lines next and re-checks each stamp
 * (`stampHeld`). Runs under the caller's `lock_timeout`; a contention escapes raw for it to type.
 */
export function shareLockStampedSessions(companyId: string, lineIds: readonly string[]): Promise<Map<string, ReconciliationSession>> {
  return shareLock(`WHERE r.id IN (SELECT bt.reconciliation_id FROM bank_transactions bt
    WHERE bt.id = ANY($1::UUID[]) AND bt.company_id = $2::UUID)`, lineIds, companyId);
}

/**
 * A locked line's stamp must be a session this request holds (or none). A stamp that moved between the peek and the
 * line lock — start claimed the line, cancel released it — names a session taken AFTER the line, the order this
 * module forbids, so the request is refused as contention: nothing was written, a retry takes it in order.
 */
export function stampHeld(row: DbRow, sessions: Map<string, ReconciliationSession>): boolean {
  return !row.reconciliation_id || sessions.has(String(row.reconciliation_id));
}

const heldSession = () => new RowLockTimeoutError('The bank reconciliation');

/**
 * FOR SHARE on one session for a line writer that names it (match / auto-match into a session), BEFORE any line
 * lock, under the 5 s budget (held -> `RowLockTimeoutError`, 503 + Retry-After). `null` for a missing or other
 * tenant's session — the caller keeps its own not-found answer.
 */
export function shareLockSession(companyId: string, id: string): Promise<ReconciliationSession | null> {
  return lockSession(companyId, id, 'share');
}

async function lockSession(companyId: string, id: string, mode: 'share' | 'update'): Promise<ReconciliationSession | null> {
  const rows = await withRowLockBudget(async () => (mode === 'update'
    ? await sql`
      SELECT r.id::TEXT AS id, r.status, r.statement_date, r.bank_account_id, r.completed_at, a.account_name
      FROM bank_reconciliations r
      LEFT JOIN gl_accounts a ON a.id = r.bank_account_id AND a.company_id = r.company_id
      WHERE r.id = ${id}::UUID AND r.company_id = ${companyId}::UUID
      FOR UPDATE OF r`
    : await sql`
      SELECT r.id::TEXT AS id, r.status, r.statement_date, r.bank_account_id, r.completed_at, a.account_name
      FROM bank_reconciliations r
      LEFT JOIN gl_accounts a ON a.id = r.bank_account_id AND a.company_id = r.company_id
      WHERE r.id = ${id}::UUID AND r.company_id = ${companyId}::UUID
      FOR SHARE OF r`) as DbRow[], heldSession, { isTimeout: isLockContention });
  return rows[0] ? toSession(rows[0]) : null;
}

/**
 * FOR UPDATE on a session for a header change (complete, cancel, reopen, adjustment), FIRST — before any read the
 * change decides on — under the 5 s budget. Waits for every line writer holding it FOR SHARE.
 */
export function lockSessionForHeaderChange(companyId: string, id: string): Promise<ReconciliationSession | null> {
  return lockSession(companyId, id, 'update');
}

/**
 * THE value of `reconciliation_id` for a write that turns a line `matched` OUTSIDE a session: the stamp is kept
 * while its session is in progress (the line joins that session's matches, as it always did) and cleared otherwise —
 * a completed session's stale stamp on a `matched` line would ADD the line to the signed-off session. FOR SHARE so an
 * unlocked writer (bulk accept, asset/fleet link, the automatic evidence attach) waits for a completion in flight and
 * then reads `completed`. For an unaliased `UPDATE bank_transactions`.
 */
export function openStampOnly(companyId: string): Fragment {
  return sql.unsafe(`(SELECT open_r.id FROM bank_reconciliations open_r
    WHERE open_r.id = bank_transactions.reconciliation_id AND open_r.company_id = $1::UUID
      AND open_r.status = 'in_progress'
    FOR SHARE)`, [companyId]);
}
