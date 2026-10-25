/**
 * The two kinds of write a mirror scan makes (S-07e part B, migration 946),
 * shared by imapMirrorService and sentMirrorService.
 *
 * stampConnection: a write to the connection row itself (cursor, last_scan_at,
 * last_success_at, last_error, counters). No app role may write those tables,
 * so it runs on the migration_admin login (`routeAdminQuery`), one fixed
 * statement keyed on the connection AND its company, in a short transaction
 * that waits at most 2 s for the row and commits on its own.
 *
 * afterRequestCommit: what a scan records about itself (stampScan, and the
 * error and stop stamps of mirrorScanError.ts). A stamp commits on its own, so
 * made inside a request (scan-now) it would outlive a request that then rolls
 * back: a cursor past documents the rollback removed, never re-ingested. In a
 * request the stamps are therefore queued and run, in the order they were made,
 * once the request has COMMITTED (runAfterCommit), each failure logged, none
 * thrown; the request holds no lock the stamp would wait for (it never writes the
 * row itself, and the key-share lock its scan-log INSERT takes does not conflict
 * with an UPDATE of these columns). Outside a request (the cron) they run now.
 *
 * scanWrite: a scan-log row, on the app pool. Its INSERT takes a key-share lock
 * on the connection row through the foreign key, which another session's
 * FOR UPDATE blocks. The cron scans its connections one after another, so an
 * unbounded wait on one locked row would stall every connection behind it:
 * outside a request each log write runs in a short transaction of its own that
 * waits at most SCAN_LOCK_WAIT (`set_config(..., true)` is transaction-local,
 * so the pooled connection is not left with it). Inside a request it runs on
 * the request's own transaction, whose lock_timeout must not change.
 *
 * A write that gives up on a lock (55P03) makes the scan skip its connection
 * for this tick: isScanLockSkip tells the caller, which warns and moves on
 * without marking the connection failed and without advancing its cursor (the
 * next tick re-scans the messages the skipped scan had already ingested: both
 * mirrors skip a file the company already holds, by company_id and content hash).
 */
import { als } from '@/lib/als';
import { runAfterCommit, runAfterRollback } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { sql, withTransaction } from '@/lib/neon';
import { routeAdminQuery } from '@/lib/auth/routeAdminPool';

/** The log scope of each mirror. */
export type MirrorScope = 'imap-mirror' | 'sent-mirror';

/** SQLSTATE lock_not_available. */
export const LOCK_NOT_AVAILABLE = '55P03';

/** How long a scan-log write outside a request waits for a row another transaction holds. */
export const SCAN_LOCK_WAIT = '2s';

export type ScanTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;

/** A connection-row write that waited its bounded time in vain: skip this connection for this tick. */
export class ScanStampLockSkip extends Error {
  readonly code = LOCK_NOT_AVAILABLE;
  constructor(label: string) {
    super(`${label}: the connection row is locked`);
    this.name = 'ScanStampLockSkip';
  }
}

/** Runs `write` with a tagged-template runner: the request's `sql`, or a bounded-wait transaction's. */
export async function scanWrite(write: (q: ScanTag) => Promise<unknown>): Promise<void> {
  if (als.getStore()?.client) {
    await write(sql);
    return;
  }
  await withTransaction(async (tx) => {
    await tx`SELECT set_config('lock_timeout', ${SCAN_LOCK_WAIT}, true)`;
    await write(tx);
  });
}

/** Runs one fixed statement on a connection row, on migration_admin (see the header); 55P03 becomes ScanStampLockSkip. */
export async function stampConnection(label: string, text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return await routeAdminQuery(label, text, params);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) throw new ScanStampLockSkip(label);
    throw err;
  }
}

/** True when `err` is a bounded wait that ran out (a stamp's, or a scan-log write's outside a request): skip this tick. */
export function isScanLockSkip(err: unknown): boolean {
  if (err instanceof ScanStampLockSkip) return true;
  return (err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE && !als.getStore()?.client;
}

interface RequestQueue {
  stamps: Array<() => Promise<void>>;
  /** Run once, after the last stamp has run (a stamp never throws): scan claims, see releaseAfterRequestStamps. */
  finalizers: Array<() => void>;
}
const requestQueues = new WeakMap<object, RequestQueue>();

/** The request's one queue, created (and registered to run after COMMIT) by whoever needs it first. */
function requestQueue(store: object): RequestQueue {
  let queue = requestQueues.get(store);
  if (!queue) {
    const q: RequestQueue = { stamps: [], finalizers: [] };
    runAfterCommit('mirror scan stamps', async () => {
      try {
        for (const stamp of q.stamps) await stamp();
      } finally {
        for (const done of q.finalizers) done();
      }
    });
    requestQueues.set(store, q); // after runAfterCommit: it throws when the request cannot run after-commit work
    queue = q;
  }
  return queue;
}

/**
 * Runs `run` now, or, in a request, after the request COMMITs, after the stamps queued before it
 * (see the header). `run` need not catch: in a request a failure is logged here, outside one it throws.
 */
export async function afterRequestCommit(scope: MirrorScope, label: string, run: () => Promise<unknown>): Promise<void> {
  const store = als.getStore();
  if (!store?.client) {
    await run();
    return;
  }
  if (store.finished) {
    // A scan the deadline abandoned writing after its request ended: the deadline's owner has stamped the row.
    log.warn('mirror scan stamp dropped: the request has finished', { label }, scope);
    return;
  }
  requestQueue(store).stamps.push(async () => {
    try {
      await run();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (isScanLockSkip(err)) log.warn('mirror scan stamp skipped: the connection row is locked', { label, code }, scope);
      else log.error('mirror scan stamp failed', { label, code, err: message }, scope);
    }
  });
}

/** The longest a scan's claim outlives its scan inside a request, if the request's COMMIT or ROLLBACK never reports. */
export const CLAIM_BACKSTOP_MS = 60_000;

/**
 * Releases a scan's claim (mirrorScanActive.ts) once the request's queued stamps have run: after the last of them
 * when the request COMMITs, at once when it does not (runAfterRollback). Released earlier, a cron tick could start a
 * scan of the connection in the window between the scan's return and the COMMIT: it would read the old cursor and
 * not see the documents this request has not committed, and capture a file twice. Outside a request, or one that
 * has finished, the claim is released now. `release` is idempotent; a backstop timer frees it if neither report
 * ever comes, so a claim can never be permanent.
 */
export function releaseAfterRequestStamps(release: () => void): void {
  const store = als.getStore();
  if (!store?.client || store.finished) {
    release();
    return;
  }
  const backstop = setTimeout(release, CLAIM_BACKSTOP_MS);
  backstop.unref();
  const done = () => { clearTimeout(backstop); release(); };
  try {
    requestQueue(store).finalizers.push(done);
    runAfterRollback('mirror scan claim (request rolled back)', async () => done());
  } catch (err) {
    log.warn('mirror scan claim released early: no after-commit queue on this request', { err: String((err as Error)?.message ?? err) }, 'imap-mirror');
    done();
  }
}

/** The cron's due selection: a pool timeout or lock wait (isScanLockSkip) skips this tick with no connection scanned. */
export async function dueOrSkipTick<T>(select: () => Promise<T[]>, scope: MirrorScope): Promise<T[]> {
  try {
    return await select();
  } catch (err) {
    if (!isScanLockSkip(err)) throw err;
    log.warn('mirror scan tick skipped: the route write pool is busy or the due rows are locked', {}, scope);
    return [];
  }
}

/** stampConnection for what a scan records about itself: after the request's COMMIT inside one (see the header). */
export async function stampScan(scope: MirrorScope, label: string, text: string, params: unknown[]): Promise<void> {
  await afterRequestCommit(scope, label, () => stampConnection(label, text, params));
}
