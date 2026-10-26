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
 * A third bound per user: one user holds at most `perOwner` places, running or waiting, so one
 * user cannot take every place (429 with Retry-After past it). The user is the session token's
 * `sub`, checked by its signature alone (local, no database); a request with no session cookie,
 * or one whose token does not verify, is passed straight to withAuth (which 401s it) without
 * taking a slot. A waiter whose client has gone (request destroyed or aborted, response ended)
 * when its turn comes is skipped and the slot passes on. Server-side only.
 */
import type { NextApiHandler } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { ACCESS_COOKIE, parseCookies } from '@/lib/auth/cookies';
import { verifyTokenSignature } from '@/lib/auth/gotrue';
import { log } from '@/lib/logger';

/** Refused a slot: the queue was full, or none came free within the wait. */
export class CpuSlotBusyError extends Error {
  constructor(readonly slot: string, readonly reason: 'queue-full' | 'timeout' | 'owner-limit') {
    super(`No ${slot} slot (${reason})`);
    this.name = 'CpuSlotBusyError';
  }
}

export class CpuSlot {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  /** Places (running or waiting) per owner. */
  private readonly held = new Map<string, number>();

  constructor(readonly name: string, readonly max: number, readonly queue: number, readonly waitMs: number, readonly perOwner = Number.POSITIVE_INFINITY) {}

  /** How many run and wait now (tests wait on it instead of sleeping). */
  stats(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  /** Runs `work` in a slot for `owner`; throws CpuSlotBusyError, without running it, when none is to be had. */
  async run<T>(work: () => Promise<T>, owner?: string): Promise<T> {
    if (owner !== undefined) {
      const mine = this.held.get(owner) ?? 0;
      if (mine >= this.perOwner) throw new CpuSlotBusyError(this.name, 'owner-limit');
      this.held.set(owner, mine + 1);
    }
    try {
      if (this.running >= this.max) await this.wait();
      else this.running++;
      try {
        return await work();
      } finally {
        const next = this.waiting.shift();
        if (next) next(); // the slot passes straight to the next waiter
        else this.running--;
      }
    } finally {
      if (owner !== undefined) {
        const left = (this.held.get(owner) ?? 1) - 1;
        if (left > 0) this.held.set(owner, left); else this.held.delete(owner);
      }
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

/** The session token's subject, by signature alone; null when it does not verify. */
type VerifySub = (token: string) => Promise<{ sub: string }>;

/**
 * The route wrapper: `slot` around everything inside it, per user. Refusals: past the user's
 * places 429, no place to be had 503, both with Retry-After. `verify` is for tests.
 */
export function withCpuSlot(slot: CpuSlot, handler: NextApiHandler, verify: VerifySub = verifyTokenSignature): NextApiHandler {
  return async (req, res) => {
    const token = parseCookies(req)[ACCESS_COOKIE];
    const owner = token ? await verify(token).then((claims) => claims.sub, () => null) : null;
    if (!owner) return handler(req, res); // withAuth 401s it, slot-free
    try {
      return await slot.run(async () => {
        const gone = req.destroyed || (req as { aborted?: boolean }).aborted === true || res.writableEnded || res.destroyed;
        if (gone) {
          log.debug('CPU slot turn skipped: the client has gone', { url: req.url, slot: slot.name }, 'API');
          return;
        }
        await handler(req, res);
      }, owner);
    } catch (err) {
      if (!(err instanceof CpuSlotBusyError)) throw err;
      log.warn('Request refused: no CPU slot', { url: req.url, slot: err.slot, reason: err.reason }, 'API');
      res.setHeader('Retry-After', String(CPU_SLOT_RETRY_AFTER_SECONDS));
      return err.reason === 'owner-limit'
        ? apiResponse.tooManyRequests(res, 'You already have two spreadsheets being read or built; wait for one to finish.')
        : apiResponse.error(res, ErrorCode.SERVICE_UNAVAILABLE, 'The server is busy reading or building other spreadsheets. Please try again in a moment.');
    }
  };
}

/**
 * The budget spreadsheets' slot, one per process, shared by the template download and the import
 * preview: two at once, four waiting at most 10 s, two places per user.
 */
export const BUDGET_SPREADSHEET_SLOT = new CpuSlot('budget spreadsheet', 2, 4, 10_000, 2);
