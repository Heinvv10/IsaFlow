/**
 * Spacing of calls to the Sage SA API — ONE pacer per process.
 *
 * Every tenant's pull goes out with IsaFlow's one SAGE_API_KEY from this
 * server's one IP, and Sage blocks the IP for an hour when it is overrun
 * (100 requests a minute). So the gap is kept between ANY two Sage calls the
 * process makes, whichever login or company they are for: a second client, or
 * a second tenant's pull, waits its turn. 700 ms is about 85 calls a minute.
 *
 * Slots are reserved in call order, so overlapping callers queue rather than
 * all waking at once. The pacer lives on globalThis: Next.js can bundle a
 * module into more than one server chunk, and module state would then be
 * per chunk (the same reason as vlmLimiter's registry).
 */

export interface SagePacer {
  /** Resolves when this caller may make its call. */
  wait(): Promise<void>;
}

export const SAGE_MIN_INTERVAL_MS = 700;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createSagePacer(
  minIntervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): SagePacer {
  let next = Number.NEGATIVE_INFINITY;
  return {
    async wait() {
      const t = now();
      const at = Math.max(t, next);
      next = at + minIntervalMs;
      if (at > t) await sleep(at - t);
    },
  };
}

const REGISTRY = Symbol.for('isaflow.sageApiPacer');

export function sharedSagePacer(): SagePacer {
  const g = globalThis as typeof globalThis & { [REGISTRY]?: SagePacer };
  return (g[REGISTRY] ??= createSagePacer(SAGE_MIN_INTERVAL_MS));
}
