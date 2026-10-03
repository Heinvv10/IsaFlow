/**
 * The process-wide render bound.
 *
 * A pack PDF render holds its request's withAuth pool connection for the whole
 * render AND the headless browser re-enters the same API for the report, so
 * unbounded concurrency exhausts the auth pool (AUTH_POOL_MAX, default 10) and
 * stalls the API for every tenant. The per-company export rate limit does not
 * cover this: one tenant's allowance is already enough, and the damage is
 * cross-tenant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { acquireRenderSlot, RenderCapacityError, RenderQueueFullError, renderSlotStats, renderSlotCeilings, renderQueueBound } from '@/lib/pdf/renderSemaphore';
import { AUTH_POOL_CONNECTION_TIMEOUT_MS, DEFAULT_AUTH_POOL_MAX, authPoolMax } from '@/lib/limits/poolLimits';
import { log } from '@/lib/logger';

const ORIGINAL = {
  max: process.env.PDF_MAX_CONCURRENT_RENDERS,
  wait: process.env.PDF_RENDER_QUEUE_TIMEOUT_MS,
  poolMax: process.env.AUTH_POOL_MAX,
};

/** Every render a test started and may have left held: finished in afterEach,
 *  so a failed assertion cannot leave slots taken and cascade into later tests. */
const everyDeferred: Array<() => void> = [];

/** A render we can finish on demand. */
function deferred() {
  let finish!: () => void;
  const started = { value: false };
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  const run = async () => { started.value = true; await promise; return 'done'; };
  everyDeferred.push(() => finish());
  return { run, finish, started };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  // A pool of 20 (ceiling 5) keeps these tests about the queue, not the default
  // pool: at the default of 10 the ceiling is 2 and clamps the 3 renders asked for.
  process.env.AUTH_POOL_MAX = '20';
  process.env.PDF_MAX_CONCURRENT_RENDERS = '3';
  process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '10000';
});

afterEach(async () => {
  while (everyDeferred.length > 0) everyDeferred.pop()!();
  await settle();
  await settle();
  if (ORIGINAL.max === undefined) delete process.env.PDF_MAX_CONCURRENT_RENDERS;
  else process.env.PDF_MAX_CONCURRENT_RENDERS = ORIGINAL.max;
  if (ORIGINAL.wait === undefined) delete process.env.PDF_RENDER_QUEUE_TIMEOUT_MS;
  else process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = ORIGINAL.wait;
  if (ORIGINAL.poolMax === undefined) delete process.env.AUTH_POOL_MAX;
  else process.env.AUTH_POOL_MAX = ORIGINAL.poolMax;
  expect(renderSlotStats()).toEqual({ active: 0, queued: 0 });
});

describe('acquireRenderSlot', () => {
  it('runs the first three concurrently and makes the fourth wait', async () => {
    const three = [deferred(), deferred(), deferred()];
    const running = three.map(d => acquireRenderSlot(d.run));
    await settle();
    expect(three.every(d => d.started.value)).toBe(true);

    const fourth = deferred();
    const queued = acquireRenderSlot(fourth.run);
    await settle();
    // The bound is real: the fourth render has not begun any work.
    expect(fourth.started.value).toBe(false);
    expect(renderSlotStats()).toEqual({ active: 3, queued: 1 });

    three[0]!.finish();
    await settle();
    expect(fourth.started.value).toBe(true);

    three.forEach(d => d.finish());
    fourth.finish();
    await Promise.all([...running, queued]);
  });

  it('refuses past the wait bound with RenderCapacityError, without running the work', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '20';

    const holder = deferred();
    const held = acquireRenderSlot(holder.run);
    await settle();

    const refused = deferred();
    await expect(acquireRenderSlot(refused.run)).rejects.toBeInstanceOf(RenderCapacityError);
    // Nothing half-done: the refused render never started.
    expect(refused.started.value).toBe(false);

    holder.finish();
    await held;
  });

  it('releases the slot when the render throws', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    await expect(acquireRenderSlot(async () => { throw new Error('render blew up'); })).rejects.toThrow('render blew up');
    expect(renderSlotStats()).toEqual({ active: 0, queued: 0 });
    // The next render still gets in.
    await expect(acquireRenderSlot(async () => 'ok')).resolves.toBe('ok');
  });

  /**
   * ADVERSARIAL HIGH-1: the wait queue itself was unbounded, so an arbitrary
   * number of requests could pile up against three slots. Past the bound a
   * request is refused IMMEDIATELY — it never waits, so it cannot be told to
   * hold on for a slot that will not arrive inside the wait bound anyway.
   */
  it('refuses immediately once the wait queue is full, rather than queueing without limit', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '2';
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '5000';
    expect(renderQueueBound()).toBe(4);

    const held = [deferred(), deferred()];
    const running = held.map(d => acquireRenderSlot(d.run));
    await settle();

    const waiters = Array.from({ length: 4 }, () => deferred());
    const queued = waiters.map(w => acquireRenderSlot(w.run));
    await settle();
    expect(renderSlotStats()).toEqual({ active: 2, queued: 4 });

    // The fifth waiter is over the bound. It is refused without waiting the
    // 5s the queue would otherwise have made it sit through.
    const overflow = deferred();
    const started = Date.now();
    await expect(acquireRenderSlot(overflow.run)).rejects.toBeInstanceOf(RenderQueueFullError);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(overflow.started.value).toBe(false);

    held.forEach(d => d.finish());
    waiters.forEach(w => w.finish());
    await Promise.all([...running, ...queued]);
  });

  it('hands a freed slot to the queue rather than letting a newcomer overtake', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    const holder = deferred();
    const held = acquireRenderSlot(holder.run);
    await settle();

    const order: string[] = [];
    const first = acquireRenderSlot(async () => { order.push('queued-first'); });
    await settle();
    const second = acquireRenderSlot(async () => { order.push('queued-second'); });
    await settle();

    holder.finish();
    await Promise.all([held, first, second]);
    expect(order).toEqual(['queued-first', 'queued-second']);
  });
});

/**
 * ADVERSARIAL LOW (2026-09-06): the two env knobs had no upper bound, and the
 * three numbers that only make sense together — the two here and the auth
 * pool's connectionTimeoutMillis — lived in two files with nothing tying them.
 * An operator raising either past what the pool can carry would have turned
 * the protection into the outage it exists to prevent, silently.
 *
 * Both ceilings are DERIVED from src/lib/auth/authPool.ts. These tests assert
 * the derivation, not a copy of the numbers: change the pool constant and the
 * expectations move with it.
 */
describe('bounds derived from the auth pool', () => {
  it('caps the queue wait below the pool acquire timeout, with a margin', () => {
    const { maxWaitMs } = renderSlotCeilings();
    expect(maxWaitMs).toBeLessThan(AUTH_POOL_CONNECTION_TIMEOUT_MS);
    // A request waiting for a slot already holds a connection; the next caller
    // is waiting on the pool. Our refusal must land first or it refuses work
    // that has already died.
    expect(maxWaitMs).toBe(AUTH_POOL_CONNECTION_TIMEOUT_MS - 2_000);
  });

  it('caps concurrency at a quarter of the pool, so renders cannot take it all', () => {
    delete process.env.AUTH_POOL_MAX;
    expect(renderSlotCeilings().maxConcurrent).toBe(Math.floor(DEFAULT_AUTH_POOL_MAX / 4));
  });

  it('at the default pool of 10 the ceiling is 2, below the default of 3 renders (R-188)', () => {
    delete process.env.AUTH_POOL_MAX;
    expect(DEFAULT_AUTH_POOL_MAX).toBe(10);
    expect(renderSlotCeilings().maxConcurrent).toBe(2);
  });

  it('tracks a changed pool size rather than holding a stale copy', () => {
    process.env.AUTH_POOL_MAX = '40';
    expect(renderSlotCeilings().maxConcurrent).toBe(10);
    process.env.AUTH_POOL_MAX = '8';
    expect(renderSlotCeilings().maxConcurrent).toBe(2);
  });

  it('an invalid AUTH_POOL_MAX gives a pool of 10, so the ceiling is a quarter of that', () => {
    for (const bad of ['abc', '0', '-3']) {
      process.env.AUTH_POOL_MAX = bad;
      expect(renderSlotCeilings().maxConcurrent).toBe(2);
    }
  });

  it('a pool of 1 is raised to 2, so a render\'s re-entry can get a second connection; the ceiling stays 1', () => {
    for (const small of ['1', '1.0', '0.5']) {
      process.env.AUTH_POOL_MAX = small;
      // The ceiling alone cannot tell a pool of 1 from a pool of 2 (both give 1);
      // the raised size is what this asserts.
      expect(authPoolMax()).toBe(2);
      expect(renderSlotCeilings().maxConcurrent).toBe(1);
    }
  });

  it('at the defaults (both env vars unset) admits 2 renders and does NOT warn: nobody set anything to clamp (R-188)', async () => {
    delete process.env.AUTH_POOL_MAX;
    delete process.env.PDF_MAX_CONCURRENT_RENDERS;
    vi.mocked(log.warn).mockClear();
    expect(renderQueueBound()).toBe(4);

    const held = [deferred(), deferred()];
    const running = held.map(d => acquireRenderSlot(d.run));
    await settle();
    expect(renderSlotStats().active).toBe(2);

    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '20';
    await expect(acquireRenderSlot(deferred().run)).rejects.toBeInstanceOf(RenderCapacityError);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      expect.stringContaining('clamped'), expect.anything(), 'pdf',
    );

    held.forEach(d => d.finish());
    await Promise.all(running);
  });

  it('a blank PDF_MAX_CONCURRENT_RENDERS is unset, not an explicit 3: no warning (R-188)', () => {
    delete process.env.AUTH_POOL_MAX;
    process.env.PDF_MAX_CONCURRENT_RENDERS = '   ';
    vi.mocked(log.warn).mockClear();
    expect(renderQueueBound()).toBe(4);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-1'])('a set but invalid PDF_MAX_CONCURRENT_RENDERS %j is logged as invalid, not as a clamp of the default (R-188)', (bad) => {
    delete process.env.AUTH_POOL_MAX;
    process.env.PDF_MAX_CONCURRENT_RENDERS = bad;
    vi.mocked(log.warn).mockClear();
    expect(renderQueueBound()).toBe(4);   // the default, clamped silently to the ceiling of 2
    const calls = vi.mocked(log.warn).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain('invalid');
    expect(calls[0]![0]).not.toContain('clamped');
    expect(calls[0]![1]).toMatchObject({ setting: 'PDF_MAX_CONCURRENT_RENDERS', length: bad.length, digitsOnly: /^[0-9]+$/.test(bad) });
    expect(JSON.stringify(calls[0])).not.toContain(`"${bad}"`);
    expect(calls[0]![1]).not.toHaveProperty('requested');
  });

  it('an EXPLICIT PDF_MAX_CONCURRENT_RENDERS of 3 over the default pool does warn: only the unset default is silent (R-188)', () => {
    delete process.env.AUTH_POOL_MAX;
    process.env.PDF_MAX_CONCURRENT_RENDERS = '3';
    vi.mocked(log.warn).mockClear();
    expect(renderQueueBound()).toBe(4);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('clamped'),
      expect.objectContaining({ setting: 'PDF_MAX_CONCURRENT_RENDERS', requested: 3, ceiling: 2 }),
      'pdf',
    );
  });

  it('clamps an over-large PDF_MAX_CONCURRENT_RENDERS and says so', async () => {
    process.env.AUTH_POOL_MAX = '20';       // ceiling 5
    process.env.PDF_MAX_CONCURRENT_RENDERS = '50';
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '20';

    const held = [deferred(), deferred(), deferred(), deferred(), deferred()];
    const running = held.map(d => acquireRenderSlot(d.run));
    await settle();
    // Five started, not fifty: the ceiling is in force, not the env value.
    expect(renderSlotStats().active).toBe(5);
    expect(held.every(d => d.started.value)).toBe(true);

    const refused = deferred();
    await expect(acquireRenderSlot(refused.run)).rejects.toBeInstanceOf(RenderCapacityError);
    expect(refused.started.value).toBe(false);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('clamped'),
      expect.objectContaining({ setting: 'PDF_MAX_CONCURRENT_RENDERS', requested: 50, ceiling: 5 }),
      'pdf',
    );

    held.forEach(d => d.finish());
    await Promise.all(running);
  });

  it('clamps an over-large PDF_RENDER_QUEUE_TIMEOUT_MS and says so', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    // Well past the pool's acquire timeout — a wait this long is the outage.
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = String(AUTH_POOL_CONNECTION_TIMEOUT_MS * 10);

    const holder = deferred();
    const held = acquireRenderSlot(holder.run);
    await settle();

    const waiter = deferred();
    const queued = acquireRenderSlot(waiter.run);
    await settle();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('clamped'),
      expect.objectContaining({
        setting: 'PDF_RENDER_QUEUE_TIMEOUT_MS',
        requested: AUTH_POOL_CONNECTION_TIMEOUT_MS * 10,
        ceiling: renderSlotCeilings().maxWaitMs,
      }),
      'pdf',
    );

    holder.finish();
    await settle();
    waiter.finish();
    await Promise.all([held, queued]);
  });

  it('leaves a value inside the ceiling exactly as configured', async () => {
    process.env.AUTH_POOL_MAX = '20';
    process.env.PDF_MAX_CONCURRENT_RENDERS = '2';
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '5000';
    vi.mocked(log.warn).mockClear();

    const two = [deferred(), deferred()];
    const running = two.map(d => acquireRenderSlot(d.run));
    await settle();
    const third = deferred();
    const queued = acquireRenderSlot(third.run);
    await settle();
    expect(third.started.value).toBe(false);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      expect.stringContaining('clamped'), expect.anything(), expect.anything(),
    );

    two.forEach(d => d.finish());
    third.finish();
    await Promise.all([...running, queued]);
  });
});
