/**
 * Savepoints on one connection must nest LIFO: two siblings that interleave
 * (`Promise.all` of two reads that each use a savepoint) release each other and
 * abort the request. So siblings on the same connection QUEUE. Each nesting
 * level has its own queue per connection (held in `level`), and a savepoint
 * opened inside another queues only behind its own siblings, never behind its
 * parent. withSavepoint, withTransaction and sql.transaction all go through it.
 *
 * A plain query on the connection waits while a sibling savepoint at its level
 * is open, so it cannot land inside that savepoint's window and be undone by
 * its rollback. With none open, it goes out in the same tick.
 *
 * Rule for callers: never await, INSIDE a savepoint (or withTransaction), a
 * query or savepoint that was started OUTSIDE it on the same connection. It is
 * queued behind the savepoint that is waiting for it.
 *
 * Outside the queue: code that calls `client.query` on the request client
 * directly (the lock helpers' `SET LOCAL lock_timeout` / `set_config` before a
 * FOR UPDATE, e.g. rowLockBudget, bankTxLock, paymentLock). Run them
 * sequentially, never concurrently with a sibling savepoint: a sibling's
 * ROLLBACK TO SAVEPOINT would revert the SET LOCAL and leave the lock wait
 * unbounded.
 *
 * The wait is BOUNDED by lack of progress, not by total time: it fails only
 * when the connection has completed nothing (no statement, no savepoint) for
 * `savepointQueueWait.ms`, so a slow sibling that keeps issuing statements
 * never trips it. One statement running longer than the bound is invisible
 * here, hence the generous default. Waiters queued behind a real deadlock are
 * refused with it (they are stuck too, and the request is failing anyway).
 *
 * Why bounded: a savepoint (or a query) whose own sibling awaits it can never
 * start. Examples: a callback awaiting a promise started outside it that later
 * opens a savepoint, or a "start the read early" promise awaited inside a
 * savepoint. Unbounded, that hangs with the transaction and its row locks
 * held and no statement running, so no statement_timeout fires. Bounded, it
 * fails loudly and the request rolls back.
 *
 * Part of `@/lib/neon`; import it only from its sibling modules.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface Queue { tail: Promise<void>; open: number; progressAt: number }

const rootQueues = new WeakMap<object, Queue>();
const level = new AsyncLocalStorage<Map<object, Queue>>();
const lastActivity = new WeakMap<object, number>();

/** Record that a statement on `client` completed (resolved or failed): the connection is moving. */
export function noteActivity(client: object): void {
  lastActivity.set(client, Date.now());
}

/** How long a queue may go without anything finishing before a waiter is refused. Tests shorten it. */
// 120 s: progress (any completed statement or savepoint) re-arms it, but one long
// statement in flight is invisible here and the main pool sets no
// statement_timeout, so the bound sits well above any legitimate statement.
export const savepointQueueWait = { ms: 120_000 };

export class SavepointQueueTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} waited ${ms} ms behind a sibling savepoint on this connection: `
      + 'a savepoint is awaiting work that is queued behind it');
    this.name = 'SavepointQueueTimeoutError';
  }
}

function queueOf(client: object): Queue {
  const fromLevel = level.getStore()?.get(client);
  if (fromLevel) return fromLevel;
  let root = rootQueues.get(client);
  if (!root) { root = { tail: Promise.resolve(), open: 0, progressAt: Date.now() }; rootQueues.set(client, root); }
  return root;
}

async function bounded(client: object, queue: Queue, wait: Promise<void>, what: string): Promise<void> {
  const ms = savepointQueueWait.ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Re-arm while the queue keeps finishing work; refuse only after `ms` with no progress.
    const check = () => {
      const idle = Date.now() - Math.max(queue.progressAt, lastActivity.get(client) ?? 0);
      if (idle >= ms) reject(new SavepointQueueTimeoutError(what, ms));
      else timer = setTimeout(check, ms - idle);
    };
    timer = setTimeout(check, ms);
  });
  try {
    await Promise.race([wait, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `run` (a savepoint) once every earlier sibling savepoint on `client` at this level has finished. */
export async function queuedSavepoint<T>(client: object, name: string, run: () => Promise<T>): Promise<T> {
  const queue = queueOf(client);
  const before = queue.tail;
  let done!: () => void;
  queue.tail = new Promise<void>((resolve) => { done = resolve; });
  queue.open += 1;
  const finish = () => { queue.open -= 1; queue.progressAt = Date.now(); done(); };
  try {
    await bounded(client, queue, before, `savepoint ${name}`);
  } catch (err) {
    // Hand the slot on only when the sibling ahead really finishes, never early.
    void before.then(finish);
    throw err;
  }
  try {
    const inner = new Map(level.getStore() ?? []);
    inner.set(client, { tail: Promise.resolve(), open: 0, progressAt: Date.now() });
    return await level.run(inner, run);
  } finally {
    finish();
  }
}

/** For a plain query: a wait while a sibling savepoint at this level is open on `client`, else null (run now). */
export function openSiblingSavepoint(client: object): Promise<void> | null {
  const queue = queueOf(client);
  return queue.open === 0 ? null : bounded(client, queue, queue.tail, 'query');
}
