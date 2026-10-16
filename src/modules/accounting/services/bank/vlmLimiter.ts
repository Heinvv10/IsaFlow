/**
 * VLM limiter — a FIFO slot limiter for work that must not all run at once
 * (vLLM requests, PDF page renders). Per process.
 */

export interface SlotLimiter {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function createSlotLimiter(max: number): SlotLimiter {
  let inFlight = 0;
  const waiting: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (inFlight < max) {
      inFlight++;
      return;
    }
    // The releasing caller hands its slot straight to us, so inFlight is unchanged.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }

  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

/**
 * One limiter per key per PROCESS. Next.js can bundle a module into more than
 * one server chunk, each with its own module state; a cap held in module state
 * would then be per-chunk. The registry lives on globalThis instead.
 */
const REGISTRY = Symbol.for('isaflow.vlmSlotLimiters');

export function sharedSlotLimiter(key: string, max: number): SlotLimiter {
  const g = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, SlotLimiter> };
  const registry = (g[REGISTRY] ??= new Map<string, SlotLimiter>());
  let limiter = registry.get(key);
  if (!limiter) {
    limiter = createSlotLimiter(max);
    registry.set(key, limiter);
  }
  return limiter;
}

/** A positive integer from the environment, or the fallback. */
export function envLimit(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
