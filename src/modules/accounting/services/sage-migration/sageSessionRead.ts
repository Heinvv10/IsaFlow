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

type Listen = (event: string, listener: (c: unknown) => void) => unknown;
/**
 * Whether the pool hands `client` to another checkout between now and stop() (L4): pg-pool's release of a clean client wakes a queued
 * waiter at once, emitting 'acquire' with it, before a wrapper that delegated and then threw returns. Such a client is the waiter's: it is
 * neither released again nor closed. A pool that emits nothing is never "handed over". stop() is idempotent and says what was seen.
 */
export function watchHandOver(pool: unknown, client: unknown): { stop: () => boolean } {
  let handed = false;
  let listening = false;
  const seen = (c: unknown): void => { if (c === client) handed = true; };
  const p = pool as { on?: unknown; off?: unknown } | null;
  try {
    if (typeof p?.on === 'function' && typeof p.off === 'function') { (p.on as Listen).call(p, 'acquire', seen); listening = true; }
  } catch (e) { safeLog('watching the pool\'s checkouts failed', e); }
  return {
    stop: () => {
      if (listening) {
        listening = false;
        try { (p!.off as Listen).call(p, 'acquire', seen); } catch (e) { safeLog('removing the pool\'s checkout watch failed', e); }
      }
      return handed;
    },
  };
}

/**
 * The last resort for a connection whose release threw twice (R39r-1). Against pg-pool the second release of a client the first one had
 * already handed back always throws ("Release called on client which has already been released to the pool"), so when a wrapper threw
 * AFTER delegating, the retry destroys nothing and the client sits idle in the pool. It is then closed through the pool's own destroy
 * path (pg-pool's `_remove`: off its idle and client lists, socket ended, the queue pulsed so a waiter for the freed slot is woken, L2),
 * and the server drops whatever the session held (the run lock's advisory lock). First a logged 'error' listener is attached (MED): the
 * session and the run lock removed theirs and pg-pool drops its own on checkout, so an error while it ends would otherwise be uncaught.
 * Limits (L3): a pool without `_remove` gets `client.end()`, which ends the socket but leaves the pool's slot (and an idle entry) until
 * the pool notices; a wrapper pool or client that hands out another object than pg-pool's own never matches `_remove` by identity, so
 * nothing is taken off the inner pool's lists. Never throws: a failure is logged.
 */
export function closeConnection(pool: unknown, client: unknown, what: string): void {
  try {
    const c = client as { on?: unknown; end?: unknown } | null;
    if (typeof c?.on === 'function') (c.on as Listen).call(c, 'error', (e: unknown) => { safeLog(`${what} reported an error while it was closed`, e); });
    const p = pool as { _remove?: unknown; _pulseQueue?: unknown } | null;
    const pulse = (): void => {
      try { if (typeof p?._pulseQueue === 'function') (p._pulseQueue as () => void).call(p); } catch (e) { safeLog(`waking the pool after closing ${what} failed`, e); }
    };
    if (typeof p?._remove === 'function') { (p._remove as (cl: unknown, cb: () => void) => void).call(p, client, pulse); return; }
    if (typeof c?.end !== 'function') { safeLog(`closing ${what} failed: neither its pool nor the client can close it`, null); return; }
    Promise.resolve((c.end as () => unknown).call(c)).catch((e: unknown) => { safeLog(`closing ${what} failed`, e); });
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
