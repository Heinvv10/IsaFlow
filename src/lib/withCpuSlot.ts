/**
 * A bounded in-process slot for a CPU-heavy request stage (the budget template build and the
 * import preview's spreadsheet parse), taken as an OUTER route wrapper:
 * `withCpuSlot(slot, withAuth(...))`. The pattern of src/lib/pdf/withRenderSlot.ts, without its
 * PDF coupling (the render bound is derived from the two pool connections a render holds, and its
 * refusal speaks of PDF exports): outside withAuth, a request that waits for a slot, or is refused
 * one, holds no pool connection and no open transaction.
 *
 * Two bounds, as the render slot: at most `max` run at once, and at most `queue` wait (each for at
 * most `waitMs`); past either the answer is a retryable 503 with Retry-After, the work never begun.
 * The precheck is the render slot's: a request with no session cookie at all is passed straight
 * to withAuth (which 401s it) without taking a slot. Server-side only.
 */
import type { NextApiHandler } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { ACCESS_COOKIE, parseCookies } from '@/lib/auth/cookies';
import { log } from '@/lib/logger';

/** Refused a slot: the queue was full, or none came free within the wait. */
export class CpuSlotBusyError extends Error {
  constructor(readonly slot: string, readonly reason: 'queue-full' | 'timeout') {
    super(`No ${slot} slot (${reason})`);
    this.name = 'CpuSlotBusyError';
  }
}

export class CpuSlot {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly name: string, readonly max: number, readonly queue: number, readonly waitMs: number) {}

  /** How many run and wait now (tests wait on it instead of sleeping). */
  stats(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  /** Runs `work` in a slot; throws CpuSlotBusyError, without running it, when none is to be had. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await this.wait();
    else this.running++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // the slot passes straight to the next waiter
      else this.running--;
    }
  }

  private wait(): Promise<void> {
    if (this.waiting.length >= this.queue) return Promise.reject(new CpuSlotBusyError(this.name, 'queue-full'));
    return new Promise<void>((resolve, reject) => {
      const turn = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(turn);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new CpuSlotBusyError(this.name, 'timeout'));
      }, this.waitMs);
      this.waiting.push(turn);
    });
  }
}

/** Seconds a refused caller is told to wait. */
export const CPU_SLOT_RETRY_AFTER_SECONDS = 5;

/** The route wrapper: `slot` around everything inside it, refusals answered 503 + Retry-After. */
export function withCpuSlot(slot: CpuSlot, handler: NextApiHandler): NextApiHandler {
  return async (req, res) => {
    if (!parseCookies(req)[ACCESS_COOKIE]) return handler(req, res); // withAuth 401s it, slot-free
    try {
      return await slot.run(async () => { await handler(req, res); });
    } catch (err) {
      if (!(err instanceof CpuSlotBusyError)) throw err;
      log.warn('Request refused: no CPU slot', { url: req.url, slot: err.slot, reason: err.reason }, 'API');
      res.setHeader('Retry-After', String(CPU_SLOT_RETRY_AFTER_SECONDS));
      return apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, 'The server is busy reading or building other spreadsheets. Please try again in a moment.');
    }
  };
}

/**
 * The budget spreadsheets' slot, one per process, shared by the template download and the import
 * preview: two at once, four waiting at most 10 s.
 */
export const BUDGET_SPREADSHEET_SLOT = new CpuSlot('budget spreadsheet', 2, 4, 10_000);
