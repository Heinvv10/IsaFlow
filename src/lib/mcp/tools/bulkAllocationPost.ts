/**
 * PRD-11 §4 — the writing half of `bulk_allocate_bank_transactions`.
 *
 * Split out of the tool because everything in here is a WRITE, and the rules on
 * this side of the boundary are the opposite of the pre-write ones: a fault
 * here must reach the registry's savepoint (the only thing that unwinds the
 * journals already posted), so it is RETHROWN rather than returned.
 */
import { withSavepoint } from '@/lib/neon';
import { BulkAllocationLineError } from '../bulkAllocationLineError';
import type { ResolvedLine } from './bulkAllocationPrepare';
import { reasonForStatus, type SkippedLine } from './bulkAllocationSkip';
import { postAllocationLine } from './allocationLine';

export interface PostedLine {
  transaction_id: string;
  journal_entry_id: string;
}

export interface PostedBatch {
  lines: PostedLine[];
  /** Rows that became unallocatable AFTER the pre-check — a lost race. */
  raced: SkippedLine[];
}

/**
 * `allocateTransaction` refuses a row whose status moved on, with a message
 * built from that status: `Transaction already reconciled — cannot allocate`.
 *
 * Matched here rather than by class because the check has to survive the
 * service's own error shape changing under it, and because `pages/api/
 * accounting/ar/receipt-match/confirm.ts` already treats this exact wording as
 * the contract. Anchored on both halves so it cannot swallow an unrelated
 * message that happens to contain the word "already".
 *
 * The STATUS is captured, not discarded. It is the only thing that tells the
 * skip apart, and reporting every race as "already allocated" would tell an
 * agent its excluded transaction had been booked — so it goes through the same
 * `reasonForStatus` mapping the pre-check uses.
 */
const ALREADY_REFUSAL = /Transaction already (\S+) — cannot allocate/;

function racedStatus(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  return ALREADY_REFUSAL.exec(err.message)?.[1] ?? null;
}

/**
 * `lockBankTransactionForUpdate` waits 5s for the row and then raises
 * `BankTransactionLockTimeoutError` (code BANK_TX_LOCK_TIMEOUT). Detected by
 * CODE rather than `instanceof`: the loop must not import a bank service just
 * to compare constructors, and the code is the stable part of that contract.
 *
 * Write-free by construction — the lock is taken before anything is posted —
 * so the line is skipped rather than failing the batch.
 */
function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === 'BANK_TX_LOCK_TIMEOUT';
}

/**
 * How much of a failure's own message may reach the agent.
 *
 * The registry's `.claude.md` invariant is that a handler error surfaces NO SQL
 * and no internals; `BulkAllocationLineError` is the one exception to
 * GENERIC_FAILURE, and it would smuggle the whole class back in if it passed
 * `err.message` through verbatim. A pg error's message names the table, column
 * and constraint that failed (`insert or update on table "gl_journal_lines"
 * violates foreign key constraint "…"`), which is schema disclosure to a
 * tenant-scoped API.
 *
 * So: anything that came from the DRIVER is reduced to its SQLSTATE — an agent
 * (and the human reading its transcript) can still tell a constraint violation
 * from a deadlock, and the server log keeps the full text. Everything else is
 * a message the SERVICES wrote for exactly this audience ("Fiscal period …",
 * "VAT Input system account not found"), and is passed through, capped.
 */
const MAX_DETAIL_CHARS = 200;

/** Message shapes only a database produces, for an error that carries no code. */
const DB_TEXT = /\b(relation|constraint|column|syntax error|duplicate key)\b/i;

export function safeLineDetail(err: unknown): string {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
  // A pg error always carries a 5-character SQLSTATE. Application errors in
  // this codebase carry either no code or a named one (BANK_TX_LOCK_TIMEOUT),
  // so the shape check is what separates them.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    return `database error ${code}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (DB_TEXT.test(message)) {
    return typeof code === 'string' ? `database error ${code}` : 'database error';
  }
  return message.length > MAX_DETAIL_CHARS
    ? `${message.slice(0, MAX_DETAIL_CHARS)}…`
    : message;
}

/**
 * Posts every prepared line, in the order given (the caller sorts by
 * transaction id — see the deadlock note in writeBankBulkAllocate.ts).
 *
 * Each line runs in its OWN savepoint, the pattern `applyRules` already uses.
 * Without one, a service throw leaves the request transaction aborted (25P02)
 * and the batch cannot continue even for a fault it is entitled to skip — the
 * race path below depends on being able to carry on after a throw.
 *
 * Two outcomes for a throw, and the difference is the whole point:
 *
 *   - the row was allocated between the pre-check and this post (another
 *     request won the row lock). `allocateTransaction` re-read the settled
 *     status under its own FOR UPDATE and refused, so NOTHING was written for
 *     this line and the batch is entitled to treat it exactly like a pre-check
 *     skip: counted, reported, and the batch continues.
 *   - the row is LOCKED by another request that has not finished (5s
 *     lock_timeout, BankTransactionLockTimeoutError). Also write-free — the
 *     lock is taken before anything is posted — so it is the same class of
 *     outcome as the race: skipped, reported as retryable, batch continues.
 *     Failing 499 good lines because one row was briefly busy is the opposite
 *     of what a bulk tool is for.
 *   - anything else — a closed period, a missing contra account, a constraint —
 *     is fatal. It is rethrown as BulkAllocationLineError so the registry's
 *     savepoint unwinds the whole batch AND the agent is told which line did
 *     it. A batch endpoint must never answer a per-line cause with an
 *     unlocatable generic failure.
 */
export async function postPreparedLines(
  companyId: string,
  userId: string,
  ordered: readonly ResolvedLine[],
  toolName: string,
): Promise<PostedBatch> {
  const lines: PostedLine[] = [];
  const raced: SkippedLine[] = [];

  for (const { index, txId, line } of ordered) {
    // Sequential, not Promise.all: these share one pg connection, and
    // concurrent statements on it interleave (and corrupt the savepoint stack —
    // postgresql-gotchas §36).
    try {
      const result = await withSavepoint(
        // ≤31 chars for every index up to 499 — withSavepoint THROWS on a
        // longer name, which would fail the batch before it posted anything.
        `bulk_alloc_line_${index}`,
        () => postAllocationLine(companyId, userId, txId, line, toolName),
      );
      lines.push({
        transaction_id: result.transactionId,
        journal_entry_id: result.journalEntryId,
      });
    } catch (err) {
      const status = racedStatus(err);
      if (status !== null) {
        raced.push({ index, transaction_id: txId, reason: reasonForStatus(status) });
        continue;
      }
      if (isLockTimeout(err)) {
        raced.push({
          index, transaction_id: txId, reason: 'locked by another request — retry',
        });
        continue;
      }
      // NEVER err.message verbatim: the registry renders this text, and a pg
      // error's message names tables, columns and constraints.
      throw new BulkAllocationLineError(index, txId, safeLineDetail(err));
    }
  }

  return { lines, raced };
}
