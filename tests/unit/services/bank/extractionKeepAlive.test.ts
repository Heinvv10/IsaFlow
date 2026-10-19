/**
 * A statement read waits for a slot on the shared VLM limiter, behind other reads, for longer than the
 * 5 minutes after which a row with no sign of life is shown as interrupted. While a job is alive and
 * waiting it keeps beating; once the work settles (or the process is gone) the beating stops, so a dead
 * job still goes stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: m.warn, error: vi.fn(), debug: vi.fn() } }));

import { KEEPALIVE_INTERVAL_MS, KEEPALIVE_MS_PER_PAGE, MAX_TIMER_MS, keepAliveCeilingMs, withKeepAlive } from '@/modules/accounting/services/bank/extractionKeepAlive';
import { maxStatementPages } from '@/modules/accounting/services/bank/vlmStatementPages';
import { effectiveExtractionState, STALE_AFTER_MINUTES } from '@/modules/accounting/services/bank/statementExtractionState';

beforeEach(() => { vi.useFakeTimers(); m.warn.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

const later = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
const minutes = (n: number) => n * 60_000;

describe('withKeepAlive', () => {
  it('beats on an interval well inside the staleness limit while the work is pending', () => {
    expect(KEEPALIVE_INTERVAL_MS).toBeLessThan(minutes(STALE_AFTER_MINUTES) / 2);
  });

  it('beats every interval while the work runs, and returns its result', async () => {
    const beat = vi.fn(async () => undefined);
    const run = withKeepAlive(beat, () => later(minutes(10)).then(() => 'done'));
    await vi.advanceTimersByTimeAsync(minutes(10));
    await expect(run).resolves.toBe('done');
    expect(beat.mock.calls.length).toBe(Math.floor(minutes(10) / KEEPALIVE_INTERVAL_MS));
  });

  it('does not beat before the first interval, and not at all for work that finishes sooner', async () => {
    const beat = vi.fn(async () => undefined);
    const run = withKeepAlive(beat, () => later(KEEPALIVE_INTERVAL_MS - 1));
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS - 1);
    await run;
    expect(beat).not.toHaveBeenCalled();
  });

  it('stops beating once the work has settled, so a row nobody is working on goes stale', async () => {
    const beat = vi.fn(async () => undefined);
    await Promise.all([withKeepAlive(beat, () => later(minutes(2))), vi.advanceTimersByTimeAsync(minutes(2))]);
    const beats = beat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(minutes(30));
    expect(beat.mock.calls.length).toBe(beats);
    const lastSign = Date.now() - minutes(30);
    expect(effectiveExtractionState({ status: 'extracting', extraction_heartbeat_at: new Date(lastSign) }).status).toBe('failed');
  });

  it('stops beating when the work throws, and throws the same error', async () => {
    const beat = vi.fn(async () => undefined);
    const boom = new Error('boom');
    const run = withKeepAlive(beat, async () => { await later(minutes(2)); throw boom; });
    const caught = run.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(minutes(2));
    expect(await caught).toBe(boom);
    const beats = beat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(minutes(30));
    expect(beat.mock.calls.length).toBe(beats);
  });

  it('a beat that fails is logged and does not fail the work', async () => {
    const beat = vi.fn(async () => { throw new Error('db down'); });
    const run = withKeepAlive(beat, () => later(minutes(3)).then(() => 'done'));
    await vi.advanceTimersByTimeAsync(minutes(3));
    await expect(run).resolves.toBe('done');
    expect(beat).toHaveBeenCalled();
    expect(m.warn).toHaveBeenCalled();
  });

  it('never has two beats in flight: a slow beat is waited for, not stacked', async () => {
    let inFlight = 0;
    let most = 0;
    const beat = vi.fn(async () => {
      inFlight += 1; most = Math.max(most, inFlight);
      await later(minutes(3));
      inFlight -= 1;
    });
    const run = withKeepAlive(beat, () => later(minutes(10)));
    await vi.advanceTimersByTimeAsync(minutes(10));
    await run;
    expect(most).toBe(1);
  });
});

describe('a row that is alive and waiting is not shown as interrupted', () => {
  it('stays inside the staleness limit through a 20 minute wait, then goes stale when the beating stops', async () => {
    let lastBeat = Date.now();
    const beat = async () => { lastBeat = Date.now(); };
    const stale = () => effectiveExtractionState({ status: 'extracting', extraction_heartbeat_at: new Date(lastBeat) }).status === 'failed';
    const run = withKeepAlive(beat, () => later(minutes(20)));
    for (let minute = 1; minute <= 20; minute += 1) {
      await vi.advanceTimersByTimeAsync(minutes(1));
      expect(stale(), `minute ${minute}`).toBe(false);
    }
    await run;
    await vi.advanceTimersByTimeAsync(minutes(STALE_AFTER_MINUTES) + 1000);
    expect(stale()).toBe(true);
  });
});

describe('the keep-alive ceiling: work that never settles must not beat for ever', () => {
  const never = () => new Promise<void>(() => undefined);

  it('is the page cap times a per-page budget that covers a VLM request timeout (120 s) with room to queue', () => {
    expect(KEEPALIVE_MS_PER_PAGE).toBeGreaterThanOrEqual(120_000);
    expect(keepAliveCeilingMs()).toBe(maxStatementPages() * KEEPALIVE_MS_PER_PAGE);
  });

  it('follows VLM_MAX_STATEMENT_PAGES', () => {
    vi.stubEnv('VLM_MAX_STATEMENT_PAGES', '5');
    try {
      expect(keepAliveCeilingMs()).toBe(5 * KEEPALIVE_MS_PER_PAGE);
    } finally { vi.unstubAllEnvs(); }
  });

  it('never exceeds what setTimeout can hold: a huge page cap would fire the ceiling after 1 ms and end the beating', async () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    vi.stubEnv('VLM_MAX_STATEMENT_PAGES', '100000');
    try {
      expect(keepAliveCeilingMs()).toBe(MAX_TIMER_MS);
      const beat = vi.fn(async () => undefined);
      void withKeepAlive(beat, never, 10);
      await vi.advanceTimersByTimeAsync(120);
      expect(beat.mock.calls.length).toBeGreaterThanOrEqual(10);
    } finally { vi.unstubAllEnvs(); }
  });

  it('clamps a ceiling handed in directly too', async () => {
    const beat = vi.fn(async () => undefined);
    void withKeepAlive(beat, never, 10, 2 ** 40);
    await vi.advanceTimersByTimeAsync(120);
    expect(beat.mock.calls.length).toBeGreaterThanOrEqual(10);
  });

  it('stops beating at the ceiling while the work is still pending, and says so', async () => {
    const beat = vi.fn(async () => undefined);
    void withKeepAlive(beat, never, KEEPALIVE_INTERVAL_MS, minutes(10));
    await vi.advanceTimersByTimeAsync(minutes(10));
    const atCeiling = beat.mock.calls.length;
    expect(atCeiling).toBeGreaterThanOrEqual(9);
    expect(atCeiling).toBeLessThanOrEqual(10);
    expect(m.warn).toHaveBeenCalledWith(expect.stringContaining('ceiling'), expect.anything(), expect.anything());
    await vi.advanceTimersByTimeAsync(minutes(60));
    expect(beat.mock.calls.length).toBe(atCeiling);
  });

  it('a hung job goes stale after its last beat, so retry and delete are accepted again', async () => {
    let lastBeat = Date.now();
    void withKeepAlive(async () => { lastBeat = Date.now(); }, never, KEEPALIVE_INTERVAL_MS, minutes(10));
    await vi.advanceTimersByTimeAsync(minutes(10));
    const state = () => effectiveExtractionState({ status: 'extracting', extraction_heartbeat_at: new Date(lastBeat) }).status;
    expect(state()).toBe('extracting');
    await vi.advanceTimersByTimeAsync(minutes(STALE_AFTER_MINUTES) + 1000);
    expect(state()).toBe('failed');
  });

  it('work that settles before the ceiling is unaffected, and the ceiling timer does not outlive it', async () => {
    const beat = vi.fn(async () => undefined);
    await Promise.all([withKeepAlive(beat, () => later(minutes(2)), KEEPALIVE_INTERVAL_MS, minutes(10)), vi.advanceTimersByTimeAsync(minutes(2))]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(minutes(20));
    expect(m.warn).not.toHaveBeenCalled();
  });
});
