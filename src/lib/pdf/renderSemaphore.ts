// src/lib/pdf/renderSemaphore.ts
//
// Bounds how many page-to-PDF renders run at once in this process, and how
// many may be waiting for a turn.
//
// Why it exists: a pack render holds a withAuth pool connection for its whole
// duration (up to the 30s print-ready gate plus transport overhead) AND the
// headless browser it drives re-enters the same API to fetch the report, so
// each render occupies at least two connections for tens of seconds. Five
// unbounded concurrent exports therefore exhaust the auth pool at its
// default (AUTH_POOL_MAX 10; twenty did when it was 20) and stall every API
// request for EVERY tenant —
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
// unbounded, so an arbitrary number of requests could pile up against the
// concurrency bound; past `QUEUE_BOUND_FACTOR × max` waiters a request is refused
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

/** A render holds two auth-pool connections (the request's withAuth one, plus
 *  the print page's re-entry), so a ceiling of a quarter of the pool bounds
 *  renders to up to half the pool. At the default pool of 10 the ceiling is 2
 *  renders = 4 connections (40%); at the old pool of 20 it was 5 renders = 10
 *  (50%), and the old default of 3 renders took 6 of 20 (R-188). What is left
 *  is for ordinary traffic. */
const POOL_SHARE_DIVISOR = 4;

/** How many requests may WAIT, as a multiple of the concurrency bound. 2 is a
 *  chosen length cap, not a figure derived from timings: it keeps the backlog
 *  short so a request past it is refused up front instead of queued. Waiters
 *  within it may still time out and get the retryable 503. */
const QUEUE_BOUND_FACTOR = 2;

function maxWaitCeilingMs(): number {
  return Math.max(1, AUTH_POOL_CONNECTION_TIMEOUT_MS - POOL_TIMEOUT_MARGIN_MS);
}

function maxConcurrentCeiling(): number {
  const poolMax = authPoolMax();
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
 *  above it is clamped and logged, never honoured. An UNSET or blank variable
 *  has nothing to report: its default is clamped without a log line. */
function boundedInt(name: string, raw: string | undefined, fallback: number, ceiling: number, smallerIsSafer: boolean): number {
  const text = raw?.trim() ?? '';
  const unset = text === '';
  const n = Number(text);
  const plain = /^[0-9]+$/.test(text) && Number.isFinite(n) && n >= 1;
  let requested = fallback;
  if (plain) {
    requested = n;
  } else if (!unset) {
    // poolSizeFromEnv's rule for a spelling it refuses: a finite value above 0 gives
    // min(default, ceil(value)) (so `1.0` stays 1 and `1.9` gives 2, never above the default);
    // anything else gives the default. Warned as invalid, never as a clamp, and never with
    // the text (an env var can hold anything pasted into it).
    // Only for a COUNT, where smaller is safer. A refused TIME (the queue wait) gives the default:
    // rounding `0.5` up to a 1 ms wait would refuse every waiter at once.
    requested = smallerIsSafer && Number.isFinite(n) && n > 0 ? Math.min(fallback, Math.ceil(n)) : fallback;
    warnOnce(`${name}:invalid`, 'renderSemaphore: env value is invalid (not a whole number of 1 or more, in plain digits); using the nearest allowed value', {
      setting: name, length: text.length, digitsOnly: /^[0-9]+$/.test(text), using: Math.min(requested, ceiling),
    });
  }
  if (requested > ceiling) {
    // Not an operator's plain choice, so nothing more to say: the built-in default above the
    // ceiling (R-188: 3 against 2 at the default pool), or an invalid value already logged.
    if (!plain) return ceiling;
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
  const max = boundedInt('PDF_MAX_CONCURRENT_RENDERS', process.env.PDF_MAX_CONCURRENT_RENDERS, DEFAULT_MAX_CONCURRENT, maxConcurrentCeiling(), true);
  const waitMs = boundedInt('PDF_RENDER_QUEUE_TIMEOUT_MS', process.env.PDF_RENDER_QUEUE_TIMEOUT_MS, DEFAULT_WAIT_MS, maxWaitCeilingMs(), false);

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
  const max = boundedInt('PDF_MAX_CONCURRENT_RENDERS', process.env.PDF_MAX_CONCURRENT_RENDERS, DEFAULT_MAX_CONCURRENT, maxConcurrentCeiling(), true);
  return max * QUEUE_BOUND_FACTOR;
}
