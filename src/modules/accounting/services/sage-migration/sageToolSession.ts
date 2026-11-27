/**
 * Calls MCP tools the way the bearer transport does (src/lib/auth/bearerPipeline.ts): one request transaction as app_user with
 * the member's claims and the company, the ALS context bound, the REAL registry (scope, role fence, company guard,
 * idempotency, the tool's savepoint, the audit row). The caller is a named member of the named company or nothing runs.
 *
 * `commit: true` is one committed request (a live batch); `commit: false` rolls the whole transaction back (the dry run:
 * everything the tools did, audit rows included, goes with it).
 */
import type { Pool, PoolClient } from 'pg';
import type { RequestContext } from '@/lib/als';
import { drainAfterCommit, runOwnedContext, settleAfterRollback } from '@/lib/afterCommit';
import { getCompanyMembership } from '@/lib/auth/companyMembership';
import { normalizeCompanyRole } from '@/lib/auth/companyRoles';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { rollbackError } from '@/lib/rollbackFailed';
import type { McpToolContext } from '@/lib/mcp/types';
import { CommitRefusedError, CommitUnconfirmedError, RunEndedError, commitRefusedByServer, ConnectionLostError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError, StatementTimeoutError, type LockHolder } from './sageSessionErrors';
import { idempotencyLockText, takeKeyLockNow } from './sageKeyLock';
import { watchWaits } from './sageWaitWatch';
import { codeOf, snapshot, told, OwnError } from './sageTold';
import { connectionEnded, said, toolOutcome } from './sageSessionRead';
import { log } from '@/lib/logger';

export { toolOutcome } from './sageSessionRead';
import { SAGE_COMMIT_TIMEOUT_MS, SAGE_LOCK_TIMEOUT_MS, SAGE_STATEMENT_TIMEOUT_MS, sageAppName } from './sageTimeouts';

export { SAGE_CONNECT_TIMEOUT_MS, SAGE_KEEPALIVE_INITIAL_DELAY_MS, SAGE_LOCK_TIMEOUT_MS, SAGE_QUERY_TIMEOUT_MS, SAGE_STATEMENT_TIMEOUT_MS, sagePoolConfig } from './sageTimeouts';

export { BatchKeyHeldError, CommitRefusedError, CommitUnconfirmedError, RunEndedError, ConnectionLostError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError, StatementTimeoutError } from './sageSessionErrors';

export const MIGRATION_SCOPES = ['read:items', 'write:items', 'read:invoices', 'write:invoices', 'read:contacts'];

export interface ToolOutcome {
  isError: boolean;
  text: string;
  /** The parsed JSON of a successful call; null when the call was refused or the text is not JSON. */
  body: Record<string, unknown> | null;
  /** The registry served a STORED answer for the key (ctx.onIdempotentReplay): the tool did not run, this call wrote nothing. */
  replayed?: true;
}

export interface ToolSession {
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  readonly companyId: string;
  /** A statement of this request hit its lock_timeout (55P03, with its holder when seen) or its statement_timeout (57014); else null. */
  stall?: () => LockWaitError | StatementTimeoutError | null;
}

export class NotAMemberError extends OwnError {}


/** How long a COMMIT may take to answer (sageTimeouts.ts SAGE_COMMIT_TIMEOUT_MS: between the statement and the client query timeouts). */
export const COMMIT_TIMEOUT_MS = SAGE_COMMIT_TIMEOUT_MS;
let commitBoundMs = COMMIT_TIMEOUT_MS;
/** Test seam: shortens the bound and returns the restore. Throws unless NODE_ENV is 'test'. */
export function setCommitBoundForTests(ms: number): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setCommitBoundForTests works only in a test run (NODE_ENV=test)');
  commitBoundMs = ms;
  return () => { commitBoundMs = COMMIT_TIMEOUT_MS; };
}

const WRITE_TOOLS = new Set(mcpRegistry.listTools().filter((t) => t.write).map((t) => t.name));
const PER_USER_TOOLS = new Set(mcpRegistry.listTools().filter((t) => (t as { perUserIdempotency?: boolean }).perUserIdempotency === true).map((t) => t.name));

/**
 * Runs `fn` in one request transaction. Throws NotAMemberError when `userId` is not an active member of `companyId`. `o.wrote`: a request
 * that commits nothing but WRITES (the dry run): its ROLLBACK must be confirmed (DryRollbackUnconfirmedError).
 * A transaction the tools marked rollbackOnly, or whose COMMIT fails, is an error (`commit: true`), never a silent success.
 */
export async function withToolSession<T>(
  pool: Pool, companyId: string, userId: string, commit: boolean, fn: (s: ToolSession) => Promise<T>, o: { wrote?: boolean; onNotice?: (line: string) => void; runLockAt?: number; ended?: () => string | null } = {},
): Promise<T> {
  // The watch starts before the connect, so a connect that waits is said too (B26-1); a connect that cannot be had within the pool's
  // connectionTimeoutMillis sent nothing: before the live phase a refused start, in a live batch a failed batch, nothing written.
  // R29-1: a run that ended starts no request: nothing is sent, not even BEGIN.
  const ended = o.ended?.() ?? null;
  if (ended !== null) throw new RunEndedError(ended);
  const appName = sageAppName(companyId); // this company's sessions' name: only those are ever offered for ending (B29-3)
  const watch = watchWaits(pool, o.onNotice, { runLockAt: o.runLockAt, appName }); // runLockAt: a holder older than this run's lock may be a dead run's (R28-4)
  let client: PoolClient;
  const connecting = watch.begin();
  try {
    client = await pool.connect();
  } catch (raw) {
    watch.stop();
    const err = snapshot(raw);
    throw commit ? new LostBeforeCommitError(err) : new ConnectionLostError(err, 'no-connection');
  } finally {
    connecting();
  }
  const processID: unknown = (client as unknown as { processID?: unknown }).processID;
  const pid = typeof processID === 'number' ? processID : undefined; // its backend pid, said if its ROLLBACK is not confirmed (B24-2)
  watch.setPid(pid);
  // pg-pool drops its idle 'error' listener while a client is checked out: without one, a backend that dies mid-request is an uncaught
  // error that ends the process (B19-1). Listened to here, the rejected query drives the runner's own lost-connection path.
  let lost: Error | null = null;
  // How it was lost: the connection ENDED (the server rolls the session back), or a client query_timeout ("Query read timeout": pg leaves
  // that query running, so on a half-open socket the server may still hold the request's writes, R26-1).
  let lostBy = 'ended' as 'ended' | 'timeout';
  const onError = (err: unknown): void => { lost ??= snapshot(err); lostBy = 'ended'; }; // R37-2: the event's value, snapshotted
  client.on('error', onError);
  // Round 25-26: every query of the request is watched, through a view of the client (never a patch of it: a pool may hand out wrapped
  // clients of its own). Once the connection is lost, every later query fails at once with that loss (B26-2): it could only queue behind
  // the dead statement for its own query_timeout. A lock timeout (55P03, with the holder the watch saw) or a cancel (57014) is kept for
  // the runner: the run stops at it. Told by SQLSTATE only, never by the server's message, which it translates (R27-1). The one 57014
  // that is not a stall is the session's own: rollbackError may cancel the backend once the request is ending (`ending`).
  let lockTimedOut: unknown = null;
  let lockHolder: LockHolder | undefined;
  let statementTimedOut: unknown = null;
  let statementMs = 0; // how long the cancelled statement had run, as the session measured it: past the statement_timeout, or not
  let ending = false;
  const base = client as unknown as { query: (...a: unknown[]) => unknown };
  const watchedQuery = (...a: unknown[]): unknown => {
    if (lost !== null) return Promise.reject(lost);
    const settled = watch.begin();
    const sentAt = Date.now();
    const raw = base.query(...a);
    let promised = false;
    try { promised = raw instanceof Promise; } catch { promised = false; } // a driver's return value: read once, in a try
    if (!promised) { settled(); return raw; }
    // B36-1, B37-2: whatever the driver rejects with is snapshotted here, where it enters: no later read touches the foreign value.
    const r = (raw as Promise<unknown>).then((v) => v, (err: unknown) => { throw snapshot(err); });
    r.then(settled, (err: unknown) => {
      const code = codeOf(err);
      if (code === '55P03' && lockTimedOut === null) [lockTimedOut, lockHolder] = [err, watch.lastBlocker()]; // read before the wait ends
      else if (code === '57014' && !ending && statementTimedOut === null) [statementTimedOut, statementMs] = [err, Date.now() - sentAt];
      else if (told(err) === 'Query read timeout' && lost === null) [lost, lostBy] = [err as Error, 'timeout'];
      settled();
    });
    return r;
  };
  const db = new Proxy(client, {
    get(t, prop) {
      if (prop === 'query') return watchedQuery;
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const phase = commit ? 'live' : 'dry';
  const stall = (): LockWaitError | StatementTimeoutError | null => {
    if (lockTimedOut !== null) return new LockWaitError(lockTimedOut, lockHolder, phase);
    return statementTimedOut === null ? null : new StatementTimeoutError(statementTimedOut, phase, SAGE_STATEMENT_TIMEOUT_MS, statementMs);
  };
  /** A stall recorded by the request is what an error it caused is said as (R27-1), unless the error already says what happened. */
  const stallFirst = (err: unknown): unknown => { const s = stall(); return s !== null && !said(err) && lost === null ? s : err; };
  /** The request's own ROLLBACK: from here a 57014 may be the session's own cancel (rollbackError), never a stall. */
  // B37-1: whatever its ROLLBACK does (rejects with anything, throws), it fails as a snapshot, and a failure marks the connection unusable.
  const rollBack = async (): Promise<Error | null> => {
    ending = true;
    try { const e = await rollbackError(client, 'sage-migration'); return e === null ? null : snapshot(e); } catch (raw) { return snapshot(raw); }
  };
  let fnStarted = false; // R25-6: only a request whose work ran can have writes still held
  let committed = false;
  let owned: RequestContext | null = null;
  let unusable = false; // set when a ROLLBACK fails: the connection may still be inside its transaction
  let rolledBack = false; // the dry request's own ROLLBACK ran: the catch does not run another
  // Round 37 (part 1): the outcome of a committing request comes from its state, never from the error that surfaced: once its COMMIT was
  // sent and before an OK answer, it is CommitUnconfirmedError (or the server's refusal, read from our own snapshot), decided first.
  let commitSent = false;
  let commitOutcome: Error | null = null;
  let toolResult: unknown;
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE app_user');
    await db.query(`SET LOCAL lock_timeout = '${SAGE_LOCK_TIMEOUT_MS}ms'`); // B24-2: no lock wait of a migration request is unbounded
    await db.query(`SET LOCAL statement_timeout = '${SAGE_STATEMENT_TIMEOUT_MS}ms'`); // round 25: no statement of it either
    const claims = { sub: userId, role: 'authenticated', company_id: companyId };
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await db.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
    const membership = await getCompanyMembership(db, userId, companyId);
    const row = membership.rows[0];
    if (!row || row.account_user_id === null || !isActiveUserAccount(row)) {
      throw new NotAMemberError(`user ${userId} is not an active member of company ${companyId}`);
    }
    const ctx: McpToolContext = {
      userId, companyId, scopes: MIGRATION_SCOPES, tokenJti: 'sage-migration', oauthAppId: null,
      companyRole: normalizeCompanyRole(row.role), authMethod: 'pat',
    };
    const txCtx: RequestContext = { client: db, userId, companyId, claims, afterCommit: [], afterRollback: [] };
    owned = txCtx;
    const session: ToolSession = {
      companyId,
      stall,
      call: async (name, args) => {
        // The registry's company guard only COMPARES this with the context's company (it selects nothing); the tenant is held by the
        // membership check above, app_user under RLS and the tools' own ownership checks.
        const sent = WRITE_TOOLS.has(name) ? { ...args, company_id: companyId } : args;
        let replayed = false;
        let r: Awaited<ReturnType<typeof mcpRegistry.call>>;
        try {
          if (WRITE_TOOLS.has(name) && typeof args.idempotency_key === 'string' && args.idempotency_key.trim() !== '') {
            await takeKeyLockNow(db as never, (typeof (pool as { query?: unknown }).query === 'function' ? pool : db) as never, idempotencyLockText(companyId, name, args.idempotency_key, PER_USER_TOOLS.has(name) ? userId : undefined), commit ? 'live' : 'dry', { runLockAt: o.runLockAt, appName });
          }
          r = await mcpRegistry.call(name, sent, { ...ctx, onIdempotentReplay: () => { replayed = true; } });
        } catch (raw) {
          const err = snapshot(raw); // what a tool or the registry threw: ours as it is, anything else its snapshot
          // A stall in the registry's own bookkeeping (outside the tool's savepoint) or the key lock rejects the call: said as the stall, so
          // the dry run stops at this batch and a live run at this batch (R27-1).
          throw stallFirst(err);
        }
        const outcome = toolOutcome(r.content[0]?.text ?? '', r.isError === true);
        // A SUCCESS nobody can read must not commit what it wrote and then be listed "failed, nothing written" (B12-4): in a committed
        // request it throws, so the request rolls back and the batch really wrote nothing. (The dry run rolls back anyway.)
        if (commit && r.isError !== true && outcome.isError) throw new Error(outcome.text);
        return replayed ? { ...outcome, replayed: true } : outcome;
      },
    };
    fnStarted = true;
    const result = await runOwnedContext(txCtx, () => fn(session));
    toolResult = result;
    if (!commit) {
      const rollback = await rollBack();
      [unusable, rolledBack] = [rollback !== null, true];
      // Checked AFTER the ROLLBACK: a loss first seen there is a loss too (R21-2). A ROLLBACK that failed or did not answer for another
      // reason costs only its connection (released as broken): what the request read stands (R22-1).
      // A read timeout in a request that WROTE whose ROLLBACK is then not confirmed: the server may still hold its writes (R26-1).
      if (lost !== null && lostBy === 'timeout' && o.wrote === true && rollback !== null && !connectionEnded(rollback)) throw new DryRollbackUnconfirmedError(rollback, pid, undefined, lost);
      if (lost !== null) throw new ConnectionLostError(lost);
      if (rollback !== null && connectionEnded(rollback)) throw new ConnectionLostError(rollback);
      // A request that WROTE (the dry run) must have its ROLLBACK confirmed: else its writes may still be held (R23-5). Plain reads need not.
      if (rollback !== null && o.wrote === true) throw new DryRollbackUnconfirmedError(rollback, pid, result);
      return result;
    }
    // Lost before the COMMIT is sent: pg would not send it (the client is not queryable): the batch wrote nothing (round 22). Lost by a
    // read timeout, its backend may still hold the request's locks and the batch's key (R27-8).
    if (lost !== null) throw new LostBeforeCommitError(lost, lostBy === 'timeout' ? { pid } : undefined);
    // A lock or statement timeout in a committing request (its tool answered a failure): nothing of it is written, the run stops there.
    const stalled = stall();
    if (stalled !== null) throw stalled;
    if (txCtx.rollbackOnly) throw new Error(`the request transaction was marked rollback-only: ${txCtx.rollbackOnly}`);
    let commitTimer: ReturnType<typeof setTimeout> | undefined;
    commitSent = true;
    try {
      // Bounded like the ROLLBACK: a connection that never answers must not hang the run. A timeout is "unconfirmed", never "failed".
      await Promise.race([
        db.query('COMMIT'),
        new Promise<never>((_, reject) => { commitTimer = setTimeout(() => reject(new Error(`COMMIT did not answer within ${commitBoundMs}ms`)), commitBoundMs); commitTimer.unref?.(); }),
      ]);
    } catch (raw) {
      const err = snapshot(raw);
      // A backend killed DURING the COMMIT rejects it with a FATAL (57P01-03) before the client emits 'error' (R20-2): lost too.
      if (lost === null && connectionEnded(err)) [lost, lostBy] = [err, 'ended'];
      // The server ANSWERED it with an ERROR (57014, a deferred constraint...): rolled back, nothing written (B28-2). Not "may still land".
      // Recorded as the request's state; the catch below throws it (round 37, part 1): whatever it rejected with, unconfirmed (B36-1).
      commitOutcome = lost === null && commitRefusedByServer(err) ? new CommitRefusedError(err) : new CommitUnconfirmedError(told(err), result, lost !== null);
      throw err;
    } finally {
      clearTimeout(commitTimer);
    }
    committed = true;
    drainAfterCommit(txCtx);
    return result;
  } catch (raw) {
    const err = snapshot(raw); // anything fn, a tool or the registry threw: ours as it is, else its snapshot (round 37, part 2)
    // Part 1: sent and not answered OK, the outcome is decided here, first; the ROLLBACK and what follows can no longer replace it.
    const decided = commitSent && !committed ? (commitOutcome ?? new CommitUnconfirmedError(told(err), toolResult, lost !== null)) : null;
    if (!rolledBack) {
      const rollback = await rollBack();
      unusable = rollback !== null;
      // R24-5: a dry run that ended on an error (a stop, a bug) and whose ROLLBACK is then not confirmed still says its writes may be held.
      if (decided === null && rollback !== null && o.wrote === true && fnStarted && (lost === null || lostBy === 'timeout') && !connectionEnded(rollback) && !connectionEnded(err)) throw new DryRollbackUnconfirmedError(rollback, pid, undefined, err);
    }
    if (decided !== null) throw decided;
    // What the request already said of itself stands: a loss, an unconfirmed COMMIT or ROLLBACK, a stall (a read timeout in the dry run
    // is said as held writes, R26-1, never re-worded as "the server rolled it back"). An error after a stall the request recorded (any
    // statement: BEGIN, the membership query, the registry's bookkeeping) is that stall (R27-1); a loss is said as the loss.
    const stalled = stallFirst(err);
    if (stalled !== err) throw stalled;
    if (!said(err) && (lost !== null || connectionEnded(err))) throw commit ? new LostBeforeCommitError(lost ?? err, lost !== null && lostBy === 'timeout' ? { pid } : undefined) : new ConnectionLostError(lost ?? err);
    throw err;
  } finally {
    // Nothing here may replace the outcome above (round 37): each step on its own, a throw only logged.
    const quietly = (what: string, step: () => void): void => {
      try { step(); } catch (e) { log.error(`sage migration: ${what} failed after the request`, { message: told(e) }, 'sage-migration'); }
    };
    quietly('stopping the wait watch', () => watch.stop());
    quietly('removing the error listener', () => { client.off('error', onError); });
    try { client.release(unusable || lost !== null); } catch (e) { log.error('sage migration: releasing the connection failed after the request', { message: told(e) }, 'sage-migration'); }
    quietly('settling the request context', () => settleAfterRollback(owned, committed));
  }
}
