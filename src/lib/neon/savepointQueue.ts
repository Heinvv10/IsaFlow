/**
 * Savepoints on one connection must nest LIFO: two siblings that interleave
 * (`Promise.all` of two reads that each use a savepoint) release each other and
 * abort the request. So siblings on the same connection QUEUE. Each nesting
 * level has its own queue per connection (held in `level`), and a savepoint
 * opened inside another queues only behind its own siblings, never behind its
 * parent.
 *
 * A plain query on the connection waits while a sibling savepoint at its level
 * is open, so it cannot land inside that savepoint's window and be undone by
 * its rollback. With none open, it goes out in the same tick.
 *
 * The wait is BOUNDED. A savepoint (or a query) whose own sibling awaits it
 * cannot ever start: a callback awaiting a promise started outside it that
 * later opens a savepoint, or a "start the read early" promise awaited inside
 * a savepoint. Unbounded, that hangs with the transaction and its row locks
 * held and no statement running, so no statement_timeout fires. Bounded, it
 * fails loudly and the request rolls back.
 *
 * Part of `@/lib/neon`; import it only from its sibling modules.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface Queue { tail: Promise<void>; open: number }

const rootQueues = new WeakMap<object, Queue>();
const level = new AsyncLocalStorage<Map<object, Queue>>();

/** How long a savepoint or query waits behind a sibling before it is refused. Tests shorten it. */
export const savepointQueueWait = { ms: 30_000 };

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
  if (!root) { root = { tail: Promise.resolve(), open: 0 }; rootQueues.set(client, root); }
  return root;
}

async function bounded(wait: Promise<void>, what: string): Promise<void> {
  const ms = savepointQueueWait.ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SavepointQueueTimeoutError(what, ms)), ms);
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
  const finish = () => { queue.open -= 1; done(); };
  try {
    await bounded(before, `savepoint ${name}`);
  } catch (err) {
    // Hand the slot on only when the sibling ahead really finishes, never early.
    void before.then(finish);
    throw err;
  }
  try {
    const inner = new Map(level.getStore() ?? []);
    inner.set(client, { tail: Promise.resolve(), open: 0 });
    return await level.run(inner, run);
  } finally {
    finish();
  }
}

/** For a plain query: a wait while a sibling savepoint at this level is open on `client`, else null (run now). */
export function openSiblingSavepoint(client: object): Promise<void> | null {
  const queue = queueOf(client);
  return queue.open === 0 ? null : bounded(queue.tail, 'query');
}
