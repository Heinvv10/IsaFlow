/**
 * The process-wide render bound.
 *
 * A pack PDF render holds its request's withAuth pool connection for the whole
 * render AND the headless browser re-enters the same API for the report, so
 * unbounded concurrency exhausts the auth pool (AUTH_POOL_MAX, default 20) and
 * stalls the API for every tenant. The per-company export rate limit does not
 * cover this: one tenant's allowance is already enough, and the damage is
 * cross-tenant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { withRenderSlot, RenderCapacityError, renderSlotStats, renderSlotBounds } from '@/lib/pdf/renderSemaphore';
import { AUTH_POOL_CONNECTION_TIMEOUT_MS, DEFAULT_AUTH_POOL_MAX } from '@/lib/auth/authPool';
import { log } from '@/lib/logger';

const ORIGINAL = {
  max: process.env.PDF_MAX_CONCURRENT_RENDERS,
  wait: process.env.PDF_RENDER_QUEUE_TIMEOUT_MS,
  poolMax: process.env.AUTH_POOL_MAX,
};

/** A render we can finish on demand. */
function deferred() {
  let finish!: () => void;
  const started = { value: false };
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  const run = async () => { started.value = true; await promise; return 'done'; };
  return { run, finish, started };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  process.env.PDF_MAX_CONCURRENT_RENDERS = '3';
  process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '10000';
});

afterEach(() => {
  if (ORIGINAL.max === undefined) delete process.env.PDF_MAX_CONCURRENT_RENDERS;
  else process.env.PDF_MAX_CONCURRENT_RENDERS = ORIGINAL.max;
  if (ORIGINAL.wait === undefined) delete process.env.PDF_RENDER_QUEUE_TIMEOUT_MS;
  else process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = ORIGINAL.wait;
  if (ORIGINAL.poolMax === undefined) delete process.env.AUTH_POOL_MAX;
  else process.env.AUTH_POOL_MAX = ORIGINAL.poolMax;
  expect(renderSlotStats()).toEqual({ active: 0, queued: 0 });
});

describe('withRenderSlot', () => {
  it('runs the first three concurrently and makes the fourth wait', async () => {
    const three = [deferred(), deferred(), deferred()];
    const running = three.map(d => withRenderSlot(d.run));
    await settle();
    expect(three.every(d => d.started.value)).toBe(true);

    const fourth = deferred();
    const queued = withRenderSlot(fourth.run);
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
    const held = withRenderSlot(holder.run);
    await settle();

    const refused = deferred();
    await expect(withRenderSlot(refused.run)).rejects.toBeInstanceOf(RenderCapacityError);
    // Nothing half-done: the refused render never started.
    expect(refused.started.value).toBe(false);

    holder.finish();
    await held;
  });

  it('releases the slot when the render throws', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    await expect(withRenderSlot(async () => { throw new Error('render blew up'); })).rejects.toThrow('render blew up');
    expect(renderSlotStats()).toEqual({ active: 0, queued: 0 });
    // The next render still gets in.
    await expect(withRenderSlot(async () => 'ok')).resolves.toBe('ok');
  });

  it('hands a freed slot to the queue rather than letting a newcomer overtake', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    const holder = deferred();
    const held = withRenderSlot(holder.run);
    await settle();

    const order: string[] = [];
    const first = withRenderSlot(async () => { order.push('queued-first'); });
    await settle();
    const second = withRenderSlot(async () => { order.push('queued-second'); });
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
    const { maxWaitMs } = renderSlotBounds();
    expect(maxWaitMs).toBeLessThan(AUTH_POOL_CONNECTION_TIMEOUT_MS);
    // A request waiting for a slot already holds a connection; the next caller
    // is waiting on the pool. Our refusal must land first or it refuses work
    // that has already died.
    expect(maxWaitMs).toBe(AUTH_POOL_CONNECTION_TIMEOUT_MS - 2_000);
  });

  it('caps concurrency at a quarter of the pool, so renders cannot take it all', () => {
    expect(renderSlotBounds().maxConcurrent).toBe(Math.floor(DEFAULT_AUTH_POOL_MAX / 4));
  });

  it('tracks a changed pool size rather than holding a stale copy', () => {
    process.env.AUTH_POOL_MAX = '40';
    expect(renderSlotBounds().maxConcurrent).toBe(10);
    process.env.AUTH_POOL_MAX = '8';
    expect(renderSlotBounds().maxConcurrent).toBe(2);
  });

  it('clamps an over-large PDF_MAX_CONCURRENT_RENDERS and says so', async () => {
    process.env.AUTH_POOL_MAX = '20';       // ceiling 5
    process.env.PDF_MAX_CONCURRENT_RENDERS = '50';
    process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '20';

    const held = [deferred(), deferred(), deferred(), deferred(), deferred()];
    const running = held.map(d => withRenderSlot(d.run));
    await settle();
    // Five started, not fifty: the ceiling is in force, not the env value.
    expect(renderSlotStats().active).toBe(5);
    expect(held.every(d => d.started.value)).toBe(true);

    const refused = deferred();
    await expect(withRenderSlot(refused.run)).rejects.toBeInstanceOf(RenderCapacityError);
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
    const held = withRenderSlot(holder.run);
    await settle();

    const waiter = deferred();
    const queued = withRenderSlot(waiter.run);
    await settle();
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining('clamped'),
      expect.objectContaining({
        setting: 'PDF_RENDER_QUEUE_TIMEOUT_MS',
        requested: AUTH_POOL_CONNECTION_TIMEOUT_MS * 10,
        ceiling: renderSlotBounds().maxWaitMs,
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
    const running = two.map(d => withRenderSlot(d.run));
    await settle();
    const third = deferred();
    const queued = withRenderSlot(third.run);
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
