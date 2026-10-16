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

/** A positive integer from the environment, or the fallback. */
export function envLimit(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
