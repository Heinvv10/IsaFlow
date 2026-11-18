/**
 * The load-aware bound (tests/helpers/loadAwareTiming.ts): exact at or under one task per CPU, stretched past it, and
 * a forced low load asserts the written bound on any box. The last test is the slowdown proof: the timeout it sets is
 * the file's, so a test that runs past 10 s (the old default) passes here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CPU_BOUND_TIMEOUT_MS, expectWithin, loadAwareBound, loadPerCpu, useCpuBoundTimeout } from '../../helpers/loadAwareTiming';

useCpuBoundTimeout();

afterEach(() => { vi.unstubAllEnvs(); });

describe('loadAwareBound', () => {
  it('is the written bound at or under one runnable task per CPU', () => {
    expect(loadAwareBound(1_000, 0)).toBe(1_000);
    expect(loadAwareBound(1_000, 1)).toBe(1_000);
  });

  it('stretches by twice the load per CPU past it (load 130 on 32 CPUs: 1 s becomes 8.1 s)', () => {
    expect(loadAwareBound(1_000, 130 / 32)).toBeCloseTo(8_125, 6);
  });
});

describe('TIMING_LOAD_PER_CPU', () => {
  it('overrides the measured load, and refuses a value that is not a number >= 0', () => {
    vi.stubEnv('TIMING_LOAD_PER_CPU', '0');
    expect(loadPerCpu()).toBe(0);
    vi.stubEnv('TIMING_LOAD_PER_CPU', '3.5');
    expect(loadPerCpu()).toBe(3.5);
    vi.stubEnv('TIMING_LOAD_PER_CPU', 'high');
    expect(() => loadPerCpu()).toThrow(/TIMING_LOAD_PER_CPU/);
    vi.stubEnv('TIMING_LOAD_PER_CPU', '-1');
    expect(() => loadPerCpu()).toThrow(/TIMING_LOAD_PER_CPU/);
  });

  it('forced to 0, a 2 s run fails a 1 s bound however loaded the box is; forced to 4, it passes', () => {
    vi.stubEnv('TIMING_LOAD_PER_CPU', '0');
    expect(() => expectWithin(2_000, 1_000)).toThrow(/bound 1000 ms, 1000 ms at load 0.00/);
    vi.stubEnv('TIMING_LOAD_PER_CPU', '4');
    expect(() => expectWithin(2_000, 1_000)).not.toThrow();
  });
});

describe('useCpuBoundTimeout', () => {
  it('gives the file a one-minute timeout', async () => {
    expect(CPU_BOUND_TIMEOUT_MS).toBe(60_000);
    await new Promise((resolve) => { setTimeout(resolve, 10_500); });
  });
});
