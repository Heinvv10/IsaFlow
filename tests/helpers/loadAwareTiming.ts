/**
 * Wall-clock bounds and timeouts that measure the code, not the machine.
 *
 * velo runs a dozen worktrees' gates at once and sits at load 90-130 on 32 CPUs; there a pack composition that takes
 * 0.4 s alone took 2.6 s, and a CPU-bound test that takes 3 s alone took 15 s, so fixed bounds failed pushes that never
 * touched the code they time (wave 6, 2026-11-17). The integration gate skips such bounds outright
 * (`integrationGate.ts`); unit and component suites keep theirs and stretch them with the measured load instead, so a
 * real slowdown (a quadratic path is 10-100x) still fails on a loaded box, and on a box at or under one runnable task
 * per CPU the bound is exactly as written.
 *
 * `TIMING_LOAD_PER_CPU` overrides the measured load (e.g. `TIMING_LOAD_PER_CPU=0` asserts the written bounds on a
 * loaded box, which is how a slowdown mutation is proven to bite).
 */
import os from 'node:os';
import { expect, vi } from 'vitest';

/** The timeout of a test that computes (it never waits on I/O): load stretches it 5x; only a hang reaches a minute. */
export const CPU_BOUND_TIMEOUT_MS = 60_000;

/** The 1-minute load average per CPU, or `TIMING_LOAD_PER_CPU` when set. */
export function loadPerCpu(): number {
  const forced = process.env.TIMING_LOAD_PER_CPU;
  if (forced !== undefined && forced !== '') {
    const n = Number(forced);
    if (!Number.isFinite(n) || n < 0) throw new Error(`TIMING_LOAD_PER_CPU must be a number >= 0, got ${JSON.stringify(forced)}`);
    return n;
  }
  return os.loadavg()[0] / os.cpus().length;
}

/** `ms` at or under one runnable task per CPU; past it, `ms` times twice the load per CPU (measured: 2.6x at 3-4). */
export function loadAwareBound(ms: number, load: number = loadPerCpu()): number {
  return load > 1 ? ms * 2 * load : ms;
}

/** Asserts `elapsedMs` is under `boundMs`, stretched by the load; the message names the load it judged at. */
export function expectWithin(elapsedMs: number, boundMs: number, label = 'elapsed ms'): void {
  const load = loadPerCpu();
  const bound = loadAwareBound(boundMs, load);
  expect(elapsedMs, `${label} (bound ${boundMs} ms, ${Math.round(bound)} ms at load ${load.toFixed(2)} per CPU)`).toBeLessThan(bound);
}

/** Gives every test in the calling file the CPU-bound timeout (call once, at the top of the file). */
export function useCpuBoundTimeout(): void {
  vi.setConfig({ testTimeout: CPU_BOUND_TIMEOUT_MS });
}
