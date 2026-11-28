/**
 * How a migration request session (sageToolSession.ts) reads what a request answered and how it ended: a tool's answer, a connection that
 * ended, an error the request already said of itself. Every value read here is ours or a snapshot (sageTold.ts): no foreign value reaches it.
 */
import { CommitRefusedError, CommitUnconfirmedError, ConnectionLostError, DryRollbackUnconfirmedError, LockWaitError, LostBeforeCommitError, StatementTimeoutError } from './sageSessionErrors';
import { codeOf, told } from './sageTold';
import type { ToolOutcome } from './sageToolSession';
import { log } from '@/lib/logger';

/** A log line that cannot throw (R38-4): the logger failing, or the value's telling, is swallowed here and nowhere else. */
export const safeLog = (what: string, e: unknown): void => {
  try {
    log.error(`sage migration: ${what}`, { message: told(e) }, 'sage-migration');
  } catch {
    // The logger itself threw: there is nothing left to tell it with, and a cleanup step must not throw.
  }
};

/**
 * The last resort for a connection whose release threw twice (R39r-1). Against pg-pool the second release of a client the first one had
 * already handed back always throws ("Release called on client which has already been released to the pool"), so when a wrapper threw
 * AFTER delegating, the retry destroys nothing and the client sits in the pool. It is then closed through the pool's own destroy path
 * (pg-pool's `_remove`: taken off its idle and client lists, its socket ended), so the pool never hands out a closed client and the
 * server drops whatever the session held (the run lock's advisory lock); a pool without that path gets `client.end()`. Never throws:
 * a failure is logged.
 */
export function closeConnection(pool: unknown, client: unknown, what: string): void {
  try {
    const remove = (pool as { _remove?: unknown } | null)?._remove;
    if (typeof remove === 'function') { (remove as (c: unknown) => void).call(pool, client); return; }
    const end = (client as { end?: unknown } | null)?.end;
    if (typeof end !== 'function') { safeLog(`closing ${what} failed: neither its pool nor the client can close it`, null); return; }
    Promise.resolve((end as () => unknown).call(client)).catch((e: unknown) => { safeLog(`closing ${what} failed`, e); });
  } catch (e) {
    safeLog(`closing ${what} failed`, e);
  }
}

/**
 * The error of a connection that ended: the server terminated the backend (57P01-03), or pg's own client error (no code) for a
 * connection that ended. Nothing else (R21-1, B21-2): not a cancel or timeout (57014), a constraint, a serialization failure, a refused
 * connect, nor a code or a message that only looks like a loss (an 08006 or "terminating connection" raised by the books' own SQL on a
 * live connection). A connection that really ended also emits the client's 'error', which is listened to.
 */
export const connectionEnded = (err: unknown): boolean => {
  const code = codeOf(err); // a thrown null / undefined (R21-4); a value whose code cannot be read (B36-1): undefined
  if (typeof code === 'string') return /^57P0[123]$/.test(code);
  return code === undefined && /^Connection terminated/.test(told(err)); // err is ours or a snapshot (R37-3): no instanceof needed
};

/** What a request already said of itself (a loss, an unconfirmed COMMIT or ROLLBACK, a stall): it stands, never re-worded. */
const SAID = [ConnectionLostError, LostBeforeCommitError, CommitRefusedError, CommitUnconfirmedError, LockWaitError, StatementTimeoutError, DryRollbackUnconfirmedError];
export const said = (err: unknown): boolean => SAID.some((k) => err instanceof k);

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
