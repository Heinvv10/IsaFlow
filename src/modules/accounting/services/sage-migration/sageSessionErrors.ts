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

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** How a backend pid is shown: with the SQL that ends it, or "unknown" (a client that does not expose it). */
const pidHint = (pid: number | undefined): string => (pid === undefined ? 'backend pid unknown' : `backend pid ${pid}: wait for the server to end it, or SELECT pg_terminate_backend(${pid})`);

/**
 * The connection of a committing request was lost BEFORE its COMMIT was sent (round 22, the structural rule): pg marks such a client not
 * queryable, so no COMMIT can reach the server, and the server rolls the transaction back. The batch FAILED and nothing of it was
 * written, whatever the tool answered (its answer is not needed to say so). `cause` is the error the loss came with.
 */
export class LostBeforeCommitError extends Error {
  constructor(cause: unknown) {
    super(`the connection was lost before its COMMIT was sent (${cause instanceof Error ? cause.message : String(cause)}); nothing of it was written`, { cause });
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
  constructor(cause: unknown) {
    super(`the connection to the database was lost (${text(cause)}) in a request that commits nothing (the dry run, which writes and rolls back, the plan or a read of the books): the server rolled it back, so nothing of it was written`, { cause });
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
    const held = `the dry run's ROLLBACK was not confirmed (${cause.message}); its writes may still be held (${pidHint(pid)})`;
    super(after === undefined ? `${held}, so the live run was not started` : `${text(after)}; and ${held}`, { cause });
    this.held = held;
    this.name = 'DryRollbackUnconfirmedError';
  }
}

/** Which part of the run met a lock (R25-2): who can hold a dry key differs from who can hold a live one, and so does the safe remedy. */
export type LockPhase = 'dry' | 'live';
/** Who likely holds it, and what to do: a dry transaction can be ended; a live one may be mid-COMMIT, so it is not to be terminated blind. */
const holderHint = (holder: number | undefined, phase: LockPhase): string => (phase === 'dry'
  ? `likely a previous run's dry transaction, ${pidHint(holder)}); wait or terminate it, then re-run`
  : `${holder === undefined ? 'backend pid unknown' : `backend pid ${holder}`}: likely a previous run's live transaction whose COMMIT was not confirmed, or another client using the same key; it may be committing, so do not terminate it blind: check the books, wait for it to end, then re-run)`);

/**
 * A batch's idempotency key is locked by another session (B24-2), said at once instead of waiting on it: who holds it (`holder`, its pid),
 * and what to do, worded by phase (R25-2). A dry key ends in "-dry", so only a dry transaction can hold one.
 */
export class BatchKeyHeldError extends Error {
  constructor(readonly holder: number | undefined, readonly phase: LockPhase = 'dry') {
    super(`another session holds this batch's lock (${holderHint(holder, phase)}`);
    this.name = 'BatchKeyHeldError';
  }
}

/**
 * A statement of a migration request waited on a lock until its lock_timeout (55P03, round 25): `holder` is the backend the request was
 * seen blocked by (pg_blocking_pids), when it was seen. The request wrote nothing (its tool rolled back); the run stops at it: every later
 * batch would queue on the same holder.
 */
export class LockWaitError extends Error {
  constructor(cause: unknown, readonly holder: number | undefined, readonly phase: LockPhase) {
    super(`a lock it needs is held by another session and the wait timed out (${text(cause)}); nothing of it was written (${holderHint(holder, phase)}`, { cause });
    this.name = 'LockWaitError';
  }
}
