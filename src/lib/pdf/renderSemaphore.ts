// src/lib/pdf/renderSemaphore.ts
//
// Bounds how many page-to-PDF renders run at once in this process, and how
// many may be waiting for a turn.
//
// Why it exists: a pack render holds a withAuth pool connection for its whole
// duration (up to the 30s print-ready gate plus transport overhead) AND the
// headless browser it drives re-enters the same API to fetch the report, so
// each render occupies at least two connections for tens of seconds. Twenty
// concurrent exports from one viewer therefore exhaust the auth pool
// (AUTH_POOL_MAX, default 20) and stall every API request for EVERY tenant —
// the per-company export rate limit does not help, because the damage is
// cross-tenant and a single tenant's allowance is already enough to do it.
//
// The bound is per process, not per company: the resource being protected is
// this process's connection pool, which every tenant shares.
//
// WHERE THE SLOT IS TAKEN. `acquireRenderSlot` is a bare primitive and must be
// called from OUTSIDE withAuth — see withRenderSlot.ts, the route wrapper that
// composes as `withRenderSlot(withAuth(...))`. Acquiring it inside the handler
// was the bug this replaced: a waiter was already holding a pool connection
// and an open transaction while it waited, so the queue itself consumed the
// resource the bound exists to protect.
//
// TWO BOUNDS, NOT ONE. Excess requests WAIT rather than fail — a second export
// queued behind a first is normal and should succeed. But the queue itself was
// unbounded, so an arbitrary number of requests could pile up against three
// slots; past `QUEUE_BOUND_FACTOR × max` waiters a request is refused
// IMMEDIATELY, with no wait and nothing started. Both refusals reach the caller
// as a retryable 503, which is the honest answer: the work never began, so
// nothing is half-done.

import { log } from '@/lib/logger';
import { AUTH_POOL_CONNECTION_TIMEOUT_MS, authPoolMax } from '@/lib/limits/poolLimits';

/** Thrown when a render could not get a slot inside the wait bound. Routes
 *  translate this to a 503 with a retry message — never a 500. */
export class RenderCapacityError extends Error {
  constructor(waitedMs: number) {
    super(`No PDF render slot became available within ${waitedMs}ms`);
    this.name = 'RenderCapacityError';
  }
}

/** Thrown when the WAIT QUEUE is already full, so the request is refused
 *  without waiting at all. Distinct from RenderCapacityError only so the two
 *  are distinguishable in a log; both are a retryable 503 to the caller. */
export class RenderQueueFullError extends Error {
  constructor(queued: number) {
    super(`PDF render queue is full (${queued} waiting)`);
    this.name = 'RenderQueueFullError';
  }
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_WAIT_MS = 10_000;

// ── Coupled with src/lib/limits/poolLimits.ts ──────────────────────────────────
// Both bounds below are DERIVED from the pool's own constants, never restated,
// because the three numbers only make sense together and used to sit in two
// files with nothing tying them: an operator raising
// PDF_RENDER_QUEUE_TIMEOUT_MS past the pool's acquire timeout, or
// PDF_MAX_CONCURRENT_RENDERS past what the pool can spare, would have turned
// the protection into the outage it exists to prevent, silently.

/** The margin between the queue wait and the pool's acquire timeout. A request
 *  that waits for a render slot is ALREADY holding a connection, and the next
 *  caller behind it is waiting on `connectionTimeoutMillis`. If our wait
 *  outlasts that, the 503 we would return arrives after the pool has already
 *  failed the request — the queue would be refusing work that had died. */
const POOL_TIMEOUT_MARGIN_MS = 2_000;

/** Renders take at least two connections each (this request, plus the browser
 *  re-entering the API), and the pool must stay usable for every other tenant
 *  meanwhile. A quarter of the pool leaves three-quarters for ordinary
 *  traffic. */
const POOL_SHARE_DIVISOR = 4;

/** How many requests may WAIT, as a multiple of the concurrency bound. Two
 *  deep is a queue that drains: at three slots and a 30s render, the last
 *  waiter is served inside a minute, which is under the queue's own wait bound
 *  so it will not be refused after burning the wait. A third layer would be,
 *  so it is refused up front instead of being told to wait for something that
 *  cannot arrive in time. */
const QUEUE_BOUND_FACTOR = 2;

function maxWaitCeilingMs(): number {
  return Math.max(1, AUTH_POOL_CONNECTION_TIMEOUT_MS - POOL_TIMEOUT_MARGIN_MS);
}

function maxConcurrentCeiling(): number {
  const poolMax = authPoolMax();
  if (!Number.isFinite(poolMax) || poolMax <= 0) return DEFAULT_MAX_CONCURRENT;
  return Math.max(1, Math.floor(poolMax / POOL_SHARE_DIVISOR));
}

// Warn once per distinct clamp: this runs on every render, and a misconfigured
// env would otherwise fill the log with one line per PDF export.
const warned = new Set<string>();
function warnOnce(key: string, message: string, data: Record<string, unknown>): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(message, data, 'pdf');
}

/** Read per acquire rather than at module load: the env is read once per
 *  request either way, and it keeps the module testable without a reset hook
 *  that production would never call.
 *
 *  `ceiling` is the derived pool bound, not a taste preference — an env value
 *  above it is clamped and logged, never honoured. */
function boundedInt(name: string, raw: string | undefined, fallback: number, ceiling: number): number {
  const n = Number(raw);
  const requested = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  if (requested > ceiling) {
    warnOnce(`${name}:${requested}`, 'renderSemaphore: env value clamped to the auth-pool-derived ceiling', {
      setting: name, requested, ceiling,
    });
    return ceiling;
  }
  return requested;
}

interface Waiter {
  grant: () => void;
  refuse: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let active = 0;
const queue: Waiter[] = [];

function release(): void {
  const next = queue.shift();
  if (next) {
    // Hand the slot straight over: `active` never drops, so a burst cannot
    // slip past the bound between one render finishing and the next starting.
    clearTimeout(next.timer);
    next.grant();
    return;
  }
  active -= 1;
}

/**
 * Run `fn` holding one render slot.
 *
 * Throws — without running `fn` — either RenderQueueFullError (the wait queue
 * is already at its bound, refused immediately) or RenderCapacityError (waited
 * and no slot freed up in time).
 *
 * Call this OUTSIDE withAuth. See this file's header and withRenderSlot.ts.
 */
export async function acquireRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  const max = boundedInt('PDF_MAX_CONCURRENT_RENDERS', process.env.PDF_MAX_CONCURRENT_RENDERS, DEFAULT_MAX_CONCURRENT, maxConcurrentCeiling());
  const waitMs = boundedInt('PDF_RENDER_QUEUE_TIMEOUT_MS', process.env.PDF_RENDER_QUEUE_TIMEOUT_MS, DEFAULT_WAIT_MS, maxWaitCeilingMs());

  if (active < max) {
    active += 1;
  } else {
    if (queue.length >= max * QUEUE_BOUND_FACTOR) {
      log.warn('renderSemaphore: refused, wait queue is full', { max, queued: queue.length }, 'pdf');
      throw new RenderQueueFullError(queue.length);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: resolve,
        refuse: reject,
        timer: setTimeout(() => {
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          log.warn('renderSemaphore: refused, no slot within the wait bound', { max, waitMs, queued: queue.length }, 'pdf');
          waiter.refuse(new RenderCapacityError(waitMs));
        }, waitMs),
      };
      queue.push(waiter);
    });
  }

  try {
    return await fn();
  } finally {
    release();
  }
}

/** The CEILINGS the auth pool imposes — the most an env value is allowed to
 *  ask for, not what is currently configured. Exported so a test can assert
 *  the derivation rather than a copy of the numbers. */
export function renderSlotCeilings(): { maxConcurrent: number; maxWaitMs: number } {
  return { maxConcurrent: maxConcurrentCeiling(), maxWaitMs: maxWaitCeilingMs() };
}

/** Live counters — for tests and for a future health endpoint. */
export function renderSlotStats(): { active: number; queued: number } {
  return { active, queued: queue.length };
}

/** The most requests that may be WAITING for a slot at the current bound.
 *  Derived from the concurrency bound, so it moves with it. */
export function renderQueueBound(): number {
  const max = boundedInt('PDF_MAX_CONCURRENT_RENDERS', process.env.PDF_MAX_CONCURRENT_RENDERS, DEFAULT_MAX_CONCURRENT, maxConcurrentCeiling());
  return max * QUEUE_BOUND_FACTOR;
}
