/**
 * R-188: how renderSemaphore reads PDF_MAX_CONCURRENT_RENDERS and
 * PDF_RENDER_QUEUE_TIMEOUT_MS at the default pool of 10 (ceiling 2): a silent clamp
 * of the unset default, an invalid-value warning, the count's floor rule and the
 * timeout's default-on-refused rule. Each test re-imports the module, because the
 * warn-once memory is module state.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ORIGINAL = {
  max: process.env.PDF_MAX_CONCURRENT_RENDERS,
  wait: process.env.PDF_RENDER_QUEUE_TIMEOUT_MS,
  poolMax: process.env.AUTH_POOL_MAX,
};
const everyDeferred: Array<() => void> = [];
const freshInstances: Array<() => { active: number; queued: number }> = [];

function deferred() {
  let finish!: () => void;
  const started = { value: false };
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  const run = async () => { started.value = true; await promise; return 'done'; };
  everyDeferred.push(() => finish());
  return { run, finish, started };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  while (everyDeferred.length > 0) everyDeferred.pop()!();
  await settle();
  await settle();
  restore('PDF_MAX_CONCURRENT_RENDERS', ORIGINAL.max);
  restore('PDF_RENDER_QUEUE_TIMEOUT_MS', ORIGINAL.wait);
  restore('AUTH_POOL_MAX', ORIGINAL.poolMax);
  for (const stats of freshInstances.splice(0)) expect(stats()).toEqual({ active: 0, queued: 0 });
});

describe('render env parsing at the default pool (R-188)', () => {
  /** A fresh module instance: the semaphore's warn-once memory is module state, so tests that
   *  assert on warnings must not share it. The logger mock is re-created with the module graph. */
  async function fresh() {
    vi.resetModules();
    const sem = await import('@/lib/pdf/renderSemaphore');
    const { log: freshLog } = await import('@/lib/logger');
    vi.mocked(freshLog.warn).mockClear();
    freshInstances.push(sem.renderSlotStats);
    return { ...sem, warn: vi.mocked(freshLog.warn) };
  }

  it('at the defaults (both env vars unset) admits 2 renders and does NOT warn: nobody set anything to clamp (R-188)', async () => {
    delete process.env.AUTH_POOL_MAX;
    delete process.env.PDF_MAX_CONCURRENT_RENDERS;
    const sem = await fresh();
    expect(sem.renderQueueBound()).toBe(4);

    const held = [deferred(), deferred()];
    const running = held.map(d => sem.acquireRenderSlot(d.run));
    await settle();
    expect(sem.renderSlotStats().active).toBe(2);

    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '20';
    await expect(sem.acquireRenderSlot(deferred().run)).rejects.toBeInstanceOf(sem.RenderCapacityError);
    expect(sem.warn).not.toHaveBeenCalledWith(expect.stringContaining('clamped'), expect.anything(), 'pdf');

    held.forEach(d => d.finish());
    await Promise.all(running);
  });

  it('at the defaults the queue holds 4 behind 2 active and the 7th request is refused outright (R-188)', async () => {
    delete process.env.AUTH_POOL_MAX;
    delete process.env.PDF_MAX_CONCURRENT_RENDERS;
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '5000';
    const sem = await fresh();

    const held = [deferred(), deferred()];
    const waiters = Array.from({ length: 4 }, () => deferred());
    const running = [...held, ...waiters].map(d => sem.acquireRenderSlot(d.run));
    await settle();
    expect(sem.renderSlotStats()).toEqual({ active: 2, queued: 4 });

    const seventh = deferred();
    await expect(sem.acquireRenderSlot(seventh.run)).rejects.toBeInstanceOf(sem.RenderQueueFullError);
    expect(seventh.started.value).toBe(false);

    held.forEach(d => d.finish());
    waiters.forEach(w => w.finish());
    await Promise.all(running);
  });

  it('a blank PDF_MAX_CONCURRENT_RENDERS is unset, not an explicit 3: no warning (R-188)', async () => {
    delete process.env.AUTH_POOL_MAX;
    process.env.PDF_MAX_CONCURRENT_RENDERS = '   ';
    const sem = await fresh();
    expect(sem.renderQueueBound()).toBe(4);
    expect(sem.warn).not.toHaveBeenCalled();
  });

  // poolSizeFromEnv's rule: plain digits >= 1 as given; any other finite value > 0 gives
  // min(default, ceil(value)); anything else gives the default. Always warned as invalid.
  it.each([
    ['abc', 3], ['0', 3], ['-1', 3], ['5.5', 3], ['50.0', 3], ['0.5', 1], ['1.0', 1], ['1.9', 1], ['2.5', 2], ['0x3', 3], ['3e0', 3], ['+3', 3],
  ])('a set but invalid PDF_MAX_CONCURRENT_RENDERS %j gives %i and is logged once as invalid, never as a clamp (R-188)', async (bad, expected) => {
    process.env.AUTH_POOL_MAX = '40';     // ceiling 10, so only the parsing rule decides
    process.env.PDF_MAX_CONCURRENT_RENDERS = bad;
    const sem = await fresh();
    expect(sem.renderQueueBound()).toBe(expected * 2);

    const calls = sem.warn.mock.calls.filter(c => String(c[0]).includes('invalid'));
    expect(calls).toHaveLength(1);
    expect(sem.warn.mock.calls.some(c => String(c[0]).includes('clamped'))).toBe(false);
    expect(calls[0]![1]).toMatchObject({ setting: 'PDF_MAX_CONCURRENT_RENDERS', length: bad.length, digitsOnly: /^[0-9]+$/.test(bad) });
    expect(calls[0]![1]).not.toHaveProperty('requested');
    // Neutral about WHAT it fell back to (the default or a capped value): `using` says which.
    expect(String(calls[0]![0])).toContain('falling back');
    expect(String(calls[0]![0])).not.toContain('nearest');
    expect(calls[0]![1]).toMatchObject({ using: expected });
    expect(JSON.stringify(calls[0])).not.toContain(`"${bad}"`);
  });

  it('an invalid value above the ceiling is clamped to it silently: the invalid log already said so (R-188)', async () => {
    delete process.env.AUTH_POOL_MAX;     // ceiling 2
    process.env.PDF_MAX_CONCURRENT_RENDERS = '2.5';
    const sem = await fresh();
    expect(sem.renderQueueBound()).toBe(4);
    expect(sem.warn.mock.calls.filter(c => String(c[0]).includes('invalid'))).toHaveLength(1);
    expect(sem.warn.mock.calls.some(c => String(c[0]).includes('clamped'))).toBe(false);
  });

  it.each(['abc', '0', '-1', '0.5', '1.9', '2.5', '0x3', '3e0', '+3'])(
    'a set but invalid PDF_RENDER_QUEUE_TIMEOUT_MS %j is logged once as invalid and the wait stays the 10 s default (R-188)', async (bad) => {
      delete process.env.AUTH_POOL_MAX;
      delete process.env.PDF_MAX_CONCURRENT_RENDERS;
      process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = bad;
      const sem = await fresh();

      const held = [deferred(), deferred()];
      const running = held.map(d => sem.acquireRenderSlot(d.run));
      await settle();
      expect(sem.renderSlotStats().active).toBe(2);

      const calls = sem.warn.mock.calls.filter(c => String(c[0]).includes('invalid'));
      expect(calls).toHaveLength(1);
      expect(calls[0]![1]).toMatchObject({ setting: 'PDF_RENDER_QUEUE_TIMEOUT_MS' });
      expect(JSON.stringify(calls[0])).not.toContain(`"${bad}"`);

      // The wait is the 10 s default, not a rounded-up fragment of it: a waiter is still queued
      // just before 10 s and refused at 10 s. (0.5 rounded up would refuse every waiter at 1 ms.)
      vi.useFakeTimers();
      try {
        const refused = sem.acquireRenderSlot(deferred().run).then(() => 'ran', (e: unknown) => e);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(sem.renderSlotStats()).toEqual({ active: 2, queued: 1 });
        await vi.advanceTimersByTimeAsync(1);
        expect(await refused).toBeInstanceOf(sem.RenderCapacityError);
        expect(sem.renderSlotStats().queued).toBe(0);
      } finally {
        vi.useRealTimers();
      }

      held.forEach(d => d.finish());
      await Promise.all(running);
    });

  it("admission follows the same parsing: PDF_MAX_CONCURRENT_RENDERS '1.0' at a pool of 40 runs one render and queues the second (R-188)", async () => {
    process.env.AUTH_POOL_MAX = '40';
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1.0';
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '5000';
    const sem = await fresh();

    const first = deferred();
    const second = deferred();
    const running = [sem.acquireRenderSlot(first.run), sem.acquireRenderSlot(second.run)];
    await settle();
    expect(first.started.value).toBe(true);
    expect(second.started.value).toBe(false);
    expect(sem.renderSlotStats()).toEqual({ active: 1, queued: 1 });

    first.finish();
    second.finish();
    await Promise.all(running);
  });

  it('an EXPLICIT PDF_MAX_CONCURRENT_RENDERS of 3 over the default pool does warn: only the unset default is silent (R-188)', async () => {
    delete process.env.AUTH_POOL_MAX;
    process.env.PDF_MAX_CONCURRENT_RENDERS = '3';
    const sem = await fresh();
    expect(sem.renderQueueBound()).toBe(4);
    expect(sem.warn).toHaveBeenCalledWith(
      expect.stringContaining('clamped'),
      expect.objectContaining({ setting: 'PDF_MAX_CONCURRENT_RENDERS', requested: 3, ceiling: 2 }),
      'pdf',
    );
  });

});
