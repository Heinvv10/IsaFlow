/**
 * Calls MCP tools the way the bearer transport does (src/lib/auth/bearerPipeline.ts): one request transaction as app_user with
 * the member's claims and the company, the ALS context bound, the REAL registry (scope, role fence, company guard,
 * idempotency, the tool's savepoint, the audit row). The caller is a named member of the named company or nothing runs.
 *
 * `commit: true` is one committed request (a live batch); `commit: false` rolls the whole transaction back (the dry run:
 * everything the tools did, audit rows included, goes with it).
 */
import type { Pool } from 'pg';
import type { RequestContext } from '@/lib/als';
import { drainAfterCommit, runOwnedContext, settleAfterRollback } from '@/lib/afterCommit';
import { getCompanyMembership } from '@/lib/auth/companyMembership';
import { normalizeCompanyRole } from '@/lib/auth/companyRoles';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import { rollbackError } from '@/lib/rollbackFailed';
import type { McpToolContext } from '@/lib/mcp/types';
import { CommitUnconfirmedError, ConnectionLostError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError } from './sageSessionErrors';
import { idempotencyLockText, takeKeyLockNow } from './sageKeyLock';
import { watchWaits } from './sageWaitWatch';
import { SAGE_LOCK_TIMEOUT_MS, SAGE_STATEMENT_TIMEOUT_MS } from './sageTimeouts';

export { SAGE_KEEPALIVE_INITIAL_DELAY_MS, SAGE_LOCK_TIMEOUT_MS, SAGE_QUERY_TIMEOUT_MS, SAGE_STATEMENT_TIMEOUT_MS, sagePoolConfig } from './sageTimeouts';

export { BatchKeyHeldError, CommitUnconfirmedError, ConnectionLostError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError } from './sageSessionErrors';

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
  /** A statement of this request hit its lock_timeout (55P03, round 25): the wait, with its holder when seen; null when none did. */
  lockWait?: () => LockWaitError | null;
}

export class NotAMemberError extends Error {}


/** How long a COMMIT may take to answer: a batch of 500 items or 100 POs commits in well under this on a healthy server. */
export const COMMIT_TIMEOUT_MS = 120_000;
let commitBoundMs = COMMIT_TIMEOUT_MS;
/** Test seam: shortens the bound and returns the restore. Throws unless NODE_ENV is 'test'. */
export function setCommitBoundForTests(ms: number): () => void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setCommitBoundForTests works only in a test run (NODE_ENV=test)');
  commitBoundMs = ms;
  return () => { commitBoundMs = COMMIT_TIMEOUT_MS; };
}

/**
 * The error of a connection that ended: the server terminated the backend (57P01-03), or pg's own client error (no code) for a
 * connection that ended. Nothing else (R21-1, B21-2): not a cancel or timeout (57014), a constraint, a serialization failure, a refused
 * connect, nor a code or a message that only looks like a loss (an 08006 or "terminating connection" raised by the books' own SQL on a
 * live connection). A connection that really ended also emits the client's 'error', which is listened to.
 */
const connectionEnded = (err: unknown): boolean => {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined; // a thrown null / undefined (R21-4)
  if (typeof code === 'string') return /^57P0[123]$/.test(code);
  return code === undefined && err instanceof Error && /^Connection terminated/.test(err.message);
};

const WRITE_TOOLS = new Set(mcpRegistry.listTools().filter((t) => t.write).map((t) => t.name));
const PER_USER_TOOLS = new Set(mcpRegistry.listTools().filter((t) => (t as { perUserIdempotency?: boolean }).perUserIdempotency === true).map((t) => t.name));

/**
 * What a tool call answered. A SUCCESS whose text is not a JSON object (a proxy's HTML page, an empty answer, a list) is a failure here,
 * never an "ok" with nothing reported: a batch must not pass on an answer nobody can read.
 */
export function toolOutcome(text: string, isError: boolean): ToolOutcome {
  if (isError) return { isError: true, text, body: null };
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { isError: true, text: `the tool answered something that is not JSON (a success must be a JSON object): ${text.slice(0, 200)}`, body: null };
  }
  return { isError: false, text, body: parsed as Record<string, unknown> };
}

/**
 * Runs `fn` in one request transaction. Throws NotAMemberError when `userId` is not an active member of `companyId`. `o.wrote`: a request
 * that commits nothing but WRITES (the dry run): its ROLLBACK must be confirmed (DryRollbackUnconfirmedError).
 * A transaction the tools marked rollbackOnly, or whose COMMIT fails, is an error (`commit: true`), never a silent success.
 */
export async function withToolSession<T>(
  pool: Pool, companyId: string, userId: string, commit: boolean, fn: (s: ToolSession) => Promise<T>, o: { wrote?: boolean; onNotice?: (line: string) => void } = {},
): Promise<T> {
  const client = await pool.connect();
  const processID: unknown = (client as unknown as { processID?: unknown }).processID;
  const pid = typeof processID === 'number' ? processID : undefined; // its backend pid, said if its ROLLBACK is not confirmed (B24-2)
  // pg-pool drops its idle 'error' listener while a client is checked out: without one, a backend that dies mid-request is an uncaught
  // error that ends the process (B19-1). Listened to here, the rejected query drives the runner's own lost-connection path.
  let lost: Error | null = null;
  const onError = (err: Error): void => { lost = err; };
  client.on('error', onError);
  // Round 25: every query of the request is watched. A client query_timeout ("Query read timeout": pg leaves that query running on the
  // server) makes the connection unusable, as a loss does; a lock timeout (55P03) is kept, with the holder the watch saw. No wait is silent.
  const watch = watchWaits(pool, pid, o.onNotice);
  let lockTimedOut: unknown = null;
  // The request's queries go through a watching view of the client (never a patch of it: a pool may hand out wrapped clients of its own).
  const base = client as unknown as { query: (...a: unknown[]) => unknown };
  const watchedQuery = (...a: unknown[]): unknown => {
    const r = base.query(...a);
    if (r instanceof Promise) {
      r.then(() => watch.touch(), (err: unknown) => {
        watch.touch();
        if (err instanceof Error && err.message === 'Query read timeout') lost ??= err;
        else if ((err as { code?: unknown } | null)?.code === '55P03') lockTimedOut ??= err;
      });
    }
    return r;
  };
  const db = new Proxy(client, {
    get(t, prop) {
      if (prop === 'query') return watchedQuery;
      const v = Reflect.get(t, prop, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  const lockWait = (): LockWaitError | null => (lockTimedOut === null ? null : new LockWaitError(lockTimedOut, watch.blocker(), commit ? 'live' : 'dry'));
  let fnStarted = false; // R25-6: only a request whose work ran can have writes still held
  let committed = false;
  let owned: RequestContext | null = null;
  let unusable = false; // set when a ROLLBACK fails: the connection may still be inside its transaction
  let rolledBack = false; // the dry request's own ROLLBACK ran: the catch does not run another
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
      lockWait,
      call: async (name, args) => {
        // The registry's company guard only COMPARES this with the context's company (it selects nothing); the tenant is held by the
        // membership check above, app_user under RLS and the tools' own ownership checks.
        const sent = WRITE_TOOLS.has(name) ? { ...args, company_id: companyId } : args;
        if (WRITE_TOOLS.has(name) && typeof args.idempotency_key === 'string' && args.idempotency_key.trim() !== '') {
          await takeKeyLockNow(db as never, idempotencyLockText(companyId, name, args.idempotency_key, PER_USER_TOOLS.has(name) ? userId : undefined), commit ? 'live' : 'dry');
        }
        let replayed = false;
        const r = await mcpRegistry.call(name, sent, { ...ctx, onIdempotentReplay: () => { replayed = true; } });
        const outcome = toolOutcome(r.content[0]?.text ?? '', r.isError === true);
        // A SUCCESS nobody can read must not commit what it wrote and then be listed "failed, nothing written" (B12-4): in a committed
        // request it throws, so the request rolls back and the batch really wrote nothing. (The dry run rolls back anyway.)
        if (commit && r.isError !== true && outcome.isError) throw new Error(outcome.text);
        return replayed ? { ...outcome, replayed: true } : outcome;
      },
    };
    fnStarted = true;
    const result = await runOwnedContext(txCtx, () => fn(session));
    if (!commit) {
      const rollback = await rollbackError(client, 'sage-migration');
      [unusable, rolledBack] = [rollback !== null, true];
      // Checked AFTER the ROLLBACK: a loss first seen there is a loss too (R21-2). A ROLLBACK that failed or did not answer for another
      // reason costs only its connection (released as broken): what the request read stands (R22-1).
      if (lost !== null) throw new ConnectionLostError(lost);
      if (rollback !== null && connectionEnded(rollback)) throw new ConnectionLostError(rollback);
      // A request that WROTE (the dry run) must have its ROLLBACK confirmed: else its writes may still be held (R23-5). Plain reads need not.
      if (rollback !== null && o.wrote === true) throw new DryRollbackUnconfirmedError(rollback, pid, result);
      return result;
    }
    // Lost before the COMMIT is sent: pg would not send it (the client is not queryable): the batch wrote nothing (round 22).
    if (lost !== null) throw new LostBeforeCommitError(lost);
    // A lock timeout in a committing request (its tool answered a failure): nothing of it is written, and the run stops there (R25-3).
    const waited = lockWait();
    if (waited !== null) throw waited;
    if (txCtx.rollbackOnly) throw new Error(`the request transaction was marked rollback-only: ${txCtx.rollbackOnly}`);
    let commitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounded like the ROLLBACK: a connection that never answers must not hang the run. A timeout is "unconfirmed", never "failed".
      await Promise.race([
        db.query('COMMIT'),
        new Promise<never>((_, reject) => { commitTimer = setTimeout(() => reject(new Error(`COMMIT did not answer within ${commitBoundMs}ms`)), commitBoundMs); commitTimer.unref?.(); }),
      ]);
    } catch (err) {
      // A backend killed DURING the COMMIT rejects it with a FATAL (57P01-03) before the client emits 'error' (R20-2): lost too.
      if (lost === null && connectionEnded(err)) lost = err as Error;
      throw new CommitUnconfirmedError(err instanceof Error ? err.message : String(err), result, lost !== null);
    } finally {
      clearTimeout(commitTimer);
    }
    committed = true;
    drainAfterCommit(txCtx);
    return result;
  } catch (err) {
    if (!rolledBack) {
      const rollback = await rollbackError(client, 'sage-migration');
      unusable = rollback !== null;
      // R24-5: a dry run that ended on an error (a stop, a bug) and whose ROLLBACK is then not confirmed still says its writes may be held.
      if (rollback !== null && o.wrote === true && fnStarted && lost === null && !connectionEnded(rollback) && !connectionEnded(err)) throw new DryRollbackUnconfirmedError(rollback, pid, undefined, err);
    }
    const lossNotYetSaid = !(err instanceof ConnectionLostError || err instanceof LostBeforeCommitError || err instanceof CommitUnconfirmedError || err instanceof LockWaitError);
    if (lossNotYetSaid && (lost !== null || connectionEnded(err))) throw commit ? new LostBeforeCommitError(lost ?? err) : new ConnectionLostError(lost ?? err);
    throw err;
  } finally {
    watch.stop();
    client.off('error', onError);
    client.release(unusable || lost !== null);
    settleAfterRollback(owned, committed);
  }
}
