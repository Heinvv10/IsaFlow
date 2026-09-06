// src/lib/pdf/renderSemaphore.ts
//
// Bounds how many page-to-PDF renders run at once in this process.
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
// Excess requests WAIT rather than fail — a second export queued behind a
// first is normal and should succeed. Past the wait bound they are refused
// with a 503 the caller can retry, which is the honest answer: the work was
// never started, so nothing is half-done.

import { log } from '@/lib/logger';

/** Thrown when a render could not get a slot inside the wait bound. Routes
 *  translate this to a 503 with a retry message — never a 500. */
export class RenderCapacityError extends Error {
  constructor(waitedMs: number) {
    super(`No PDF render slot became available within ${waitedMs}ms`);
    this.name = 'RenderCapacityError';
  }
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_WAIT_MS = 10_000;

/** Read per acquire rather than at module load: the env is read once per
 *  request either way, and it keeps the module testable without a reset hook
 *  that production would never call. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
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
 * Throws RenderCapacityError — without running `fn` — if no slot frees up
 * within the wait bound.
 */
export async function withRenderSlot<T>(fn: () => Promise<T>): Promise<T> {
  const max = positiveInt(process.env.PDF_MAX_CONCURRENT_RENDERS, DEFAULT_MAX_CONCURRENT);
  const waitMs = positiveInt(process.env.PDF_RENDER_QUEUE_TIMEOUT_MS, DEFAULT_WAIT_MS);

  if (active < max) {
    active += 1;
  } else {
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

/** Live counters — for tests and for a future health endpoint. */
export function renderSlotStats(): { active: number; queued: number } {
  return { active, queued: queue.length };
}
