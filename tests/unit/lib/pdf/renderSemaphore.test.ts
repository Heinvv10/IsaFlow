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

import { withRenderSlot, RenderCapacityError, renderSlotStats } from '@/lib/pdf/renderSemaphore';

const ORIGINAL = {
  max: process.env.PDF_MAX_CONCURRENT_RENDERS,
  wait: process.env.PDF_RENDER_QUEUE_TIMEOUT_MS,
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
