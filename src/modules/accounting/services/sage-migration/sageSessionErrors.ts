/**
 * The errors a migration request session (sageToolSession.ts) raises when its connection, its ROLLBACK or a lock it needs is not what it
 * should be. Each names what is known and keeps its `cause`. Re-exported by sageToolSession.ts.
 */

/**
 * The COMMIT of a request transaction did not answer (or failed): whether it landed is unknown. Any other failure rolled the batch back.
 * `result` is what the request's work returned before the COMMIT (a live batch: the tool's own answer), so a caller can say what the batch
 * did if the COMMIT landed, never falling back on the dry run's answer. `connectionLost`: the connection was lost DURING (or after) the
 * COMMIT (R20-2): the tool's answer stands, a refusal among them (B21-1). A loss seen before the COMMIT is LostBeforeCommitError instead.
 */
export class CommitUnconfirmedError extends Error {
  constructor(message: string, readonly result: unknown, readonly connectionLost = false) { super(message); }
}

import { described, ownBackend, whoHolds, type LockHolder } from './sageLockHolder';

export type { LockHolder } from './sageLockHolder';

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The connection of a committing request was lost BEFORE its COMMIT was sent (round 22, the structural rule): pg marks such a client not
 * queryable, so no COMMIT can reach the server, and the transaction is never committed. The batch FAILED and nothing of it was written,
 * whatever the tool answered (its answer is not needed to say so). `cause` is the error the loss came with. `heldBy` (R27-8): the loss was
 * a client read timeout, so the connection may still be open on the server (a half-open socket): its backend may still hold the
 * request's locks and the batch's key until it is ended, and a re-run meets them.
 */
export class LostBeforeCommitError extends Error {
  constructor(cause: unknown, readonly heldBy?: { pid: number | undefined }) {
    super(`the connection was lost before its COMMIT was sent (${text(cause)}); nothing of it was written${heldBy === undefined ? '' : `; its backend may still hold the request's locks and the batch's key (${ownBackend(heldBy.pid)})`}`, { cause });
    this.name = 'LostBeforeCommitError';
  }
}

/**
 * The connection of a request that commits nothing was lost (B20-1): the dry run (which writes, then rolls back), the plan or a read of the
 * books. Said so, never a tool's generic failure blamed on a batch. The server rolls a lost session back, so nothing of it was written. The
 * words name that request only (R21-3): after the live phase started, other batches may have committed. Before the live phase it is a
 * refused start (exit 2). `cause` is the error the loss came with.
 */
export class ConnectionLostError extends Error {
  constructor(cause: unknown, readonly how: 'lost' | 'no-connection' = 'lost') {
    super(how === 'no-connection'
      ? `no connection to the database could be had (${text(cause)}): nothing was sent, so nothing of it was written`
      : `the connection to the database was lost (${text(cause)}) in a request that commits nothing (the dry run, which writes and rolls back, the plan or a read of the books): the server rolled it back, so nothing of it was written`, { cause });
    this.name = 'ConnectionLostError';
  }
}

/**
 * The dry run's ROLLBACK failed or did not answer for a reason other than a lost connection (R23-5): the dry run WROTE (it calls the live
 * tools in a transaction), so its rows and its locks may still be held on the server, by its backend `pid` (B24-2). `held` says that much
 * (the runner keeps a dry result with it as a warning when no live run follows, B24-1); the message adds that the live run was not started
 * (a refused start, exit 2), or follows `after`, the error the dry run itself ended with (R24-5). `result` is what the dry run returned.
 */
export class DryRollbackUnconfirmedError extends Error {
  readonly held: string;
  constructor(cause: Error, readonly pid: number | undefined, readonly result?: unknown, readonly after?: unknown) {
    const held = `the dry run's ROLLBACK was not confirmed (${cause.message}); its writes may still be held (${ownBackend(pid)})`;
    // After the dry run's own error (R27 wording): what was not written, and that no live run followed, said as for a held ROLLBACK alone.
    const first = text(after);
    const notWritten = /nothing was written/.test(first) ? '' : '; the dry run commits nothing, so nothing was written to the books'; // said once
    super(after === undefined ? `${held}, so the live run was not started` : `${first}; and ${held}${notWritten}; the live run was not started`, { cause });
    this.held = held;
    this.name = 'DryRollbackUnconfirmedError';
  }
}

/** Which part of the run met a lock (R25-2): who can hold a dry key differs from who can hold a live one, and so does the safe remedy. */
export type LockPhase = 'dry' | 'live';
/** A holder that was not seen: none was found, or the lookup failed (R27-7: said as such, never as "none"). */
const unseen = (unread: boolean): string => (unread ? 'who holds it could not be read (the lookup failed; see the log)' : 'backend pid unknown');
const who = (h: LockHolder | undefined, unread = false): string => (h === undefined ? `${unseen(unread)}: wait for it to end` : whoHolds(h));

/**
 * The live key's holder (R27-8): a backend idle in its transaction has not been sent a COMMIT (a COMMIT received makes it active, then
 * ends the transaction), so nothing of it can be committed; one at work may be committing, and is never offered for ending.
 */
const liveKeyHolder = (h: LockHolder | undefined, unread: boolean): string => {
  if (h === undefined) return `${unseen(unread)}; it may be committing, so do not terminate it blind: check the books, wait for it to end, then re-run`;
  if (/^idle in transaction/.test(h.state ?? '')) return `${whoHolds(h)}; it was never sent a COMMIT (it is idle in its transaction), so nothing of it is committed; then re-run`;
  return `${described(h)}: it may be committing, so do not terminate it: check the books, wait for it to end, then re-run`;
};

/**
 * A batch's idempotency key is locked by another session (B24-2), said at once instead of waiting on it, worded by phase (R25-2). A dry
 * key ends in "-dry", so only a dry transaction can hold one. A live key is held by a live transaction that has not ended (a previous
 * run's, cut off before or at its COMMIT), or another client using the same key: worded by what its holder is doing (R27-8), never
 * claiming an unconfirmed COMMIT. `unread`: the holder lookup failed (R27-7).
 */
export class BatchKeyHeldError extends Error {
  constructor(readonly holder: LockHolder | undefined, readonly phase: LockPhase = 'dry', readonly unread = false) {
    super(phase === 'dry'
      ? `another session holds this batch's lock: likely a previous run's dry transaction (${who(holder, unread)}); then re-run`
      : `another session holds this batch's lock: a live transaction that has not ended (a previous run's, or another client using the same key): ${liveKeyHolder(holder, unread)}`);
    this.name = 'BatchKeyHeldError';
  }
}

/**
 * A statement of a migration request waited on a lock until its lock_timeout (55P03, round 25): `holder` is the backend the request was
 * seen blocked by (pg_blocking_pids), when it was seen. Any session can hold such a lock (a user, another tool, a previous run), so only
 * who it is decides the advice (R26-4, R27-3: sageLockHolder.ts). The request wrote nothing (its tool rolled back); the run stops at it: every later batch would
 * queue on the same holder.
 */
export class LockWaitError extends Error {
  constructor(cause: unknown, readonly holder: LockHolder | undefined, readonly phase: LockPhase) {
    super(`a lock it needs is held by another session and the wait timed out (${text(cause)}); nothing of it was written (held by ${who(holder)}); then re-run`, { cause });
    this.name = 'LockWaitError';
  }
}

/**
 * A statement of a migration request was cancelled (57014, B26-4, R27-1): told by its SQLSTATE, never by the server's message (which the
 * server translates). One that had run for at least the migration's statement_timeout (`elapsedMs`, measured by the session) ran past it:
 * the server is overloaded or stalled. One cancelled sooner was cancelled by someone else (pg_cancel_backend). The request wrote nothing
 * (its tool rolled back, or the request did); the run stops at it, as at a lock wait: every later batch would meet the same.
 */
export class StatementTimeoutError extends Error {
  constructor(cause: unknown, readonly phase: LockPhase, timeoutMs: number, readonly elapsedMs: number = timeoutMs) {
    super(elapsedMs >= timeoutMs
      ? `a statement ran past the migration's ${timeoutMs / 1000} s statement_timeout (${text(cause)}); nothing of it was written: the database is overloaded or stalled; re-run once it answers`
      : `a statement was cancelled after ${Math.round(elapsedMs / 100) / 10} s, before the migration's ${timeoutMs / 1000} s statement_timeout (57014: ${text(cause)}): another session cancelled it (pg_cancel_backend); nothing of it was written; find out who, then re-run`, { cause });
    this.name = 'StatementTimeoutError';
  }
}
