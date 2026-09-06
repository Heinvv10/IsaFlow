/**
 * The render bound as an OUTER wrapper.
 *
 * ADVERSARIAL HIGH-1: the slot used to be acquired inside the handler, which
 * runs inside withAuth's pool connection and open transaction. A request
 * WAITING for a slot was therefore already holding a connection, so twenty-five
 * parallel exports from one viewer — inside the per-company export rate limit —
 * took every connection in the pool, and the renders' own inbound fetch for the
 * report had none left. The bound deadlocked the thing it was bounding.
 *
 * These tests pin the ordering property that fixes it: the slot is taken
 * BEFORE anything acquires a connection, so a queued or refused request holds
 * none. `withAuth` itself is stood in for by a wrapper that counts connections
 * the same way withAuth takes them — acquire on entry, release on exit — which
 * is the only part of it this ordering depends on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { withRenderSlot } from '@/lib/pdf/withRenderSlot';
import { renderSlotStats } from '@/lib/pdf/renderSemaphore';

const ORIGINAL = {
  max: process.env.PDF_MAX_CONCURRENT_RENDERS,
  wait: process.env.PDF_RENDER_QUEUE_TIMEOUT_MS,
};

beforeEach(() => {
  process.env.PDF_MAX_CONCURRENT_RENDERS = '3';
  process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = '5000';
});

afterEach(() => {
  if (ORIGINAL.max === undefined) delete process.env.PDF_MAX_CONCURRENT_RENDERS;
  else process.env.PDF_MAX_CONCURRENT_RENDERS = ORIGINAL.max;
  if (ORIGINAL.wait === undefined) delete process.env.PDF_RENDER_QUEUE_TIMEOUT_MS;
  else process.env.PDF_RENDER_QUEUE_TIMEOUT_MS = ORIGINAL.wait;
  expect(renderSlotStats()).toEqual({ active: 0, queued: 0 });
});

function mockRes() {
  const res = {
    statusCode: 0, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    end(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

const req = (cookie = 'sb-access-token=abc') =>
  ({ method: 'GET', url: '/api/accounting/packs/board/pdf', headers: { cookie } }) as unknown as NextApiRequest;

/** Stands in for withAuth's connection lifecycle, and nothing else: take a
 *  connection before the handler, release it after. */
function countingPool() {
  const state = { open: 0, peak: 0, acquired: 0 };
  const wrap = (inner: NextApiHandler): NextApiHandler => async (r, s) => {
    state.open += 1;
    state.acquired += 1;
    state.peak = Math.max(state.peak, state.open);
    try { await inner(r, s); } finally { state.open -= 1; }
  };
  return { state, wrap };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('withRenderSlot', () => {
  it('lets at most the configured number of requests hold a pool connection, and refuses the rest without one', async () => {
    const pool = countingPool();
    let releaseAll!: () => void;
    const gate = new Promise<void>((r) => { releaseAll = r; });

    const route = withRenderSlot(pool.wrap(async (_r, s) => {
      await gate;
      (s as unknown as { statusCode: number }).statusCode = 200;
    }));

    const responses = Array.from({ length: 25 }, () => mockRes());
    const calls = responses.map((res) => route(req(), res));
    await settle();

    // Three renders hold a connection. Nothing else has taken one: the queue
    // waits OUTSIDE withAuth, which is the whole point.
    expect(pool.state.peak).toBe(3);
    expect(pool.state.open).toBe(3);

    // Three running + a queue bounded at 2x = six waiting. The other sixteen
    // were refused immediately, and none of them touched the pool.
    const refused = responses.filter((r) => r.statusCode === 503);
    expect(refused).toHaveLength(16);
    expect(pool.state.acquired).toBe(3);
    expect(renderSlotStats()).toEqual({ active: 3, queued: 6 });

    releaseAll();
    await Promise.all(calls);

    // The nine that were admitted all ran, and never more than three at once.
    expect(pool.state.acquired).toBe(9);
    expect(pool.state.peak).toBe(3);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(9);
  });

  it('answers a refusal with a retryable 503, not a 500', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const route = withRenderSlot(async () => { await gate; });

    const held = [route(req(), mockRes()), route(req(), mockRes()), route(req(), mockRes())];
    await settle();

    const res = mockRes();
    await route(req(), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ success: false });

    release();
    await Promise.all(held);
  });

  it('passes a request with no session cookie straight to withAuth, without spending a slot', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const seen: string[] = [];
    const route = withRenderSlot(async (r, s) => {
      seen.push(String(r.headers.cookie ?? 'none'));
      // Whatever the wrapper let through, withAuth decides — here, a 401.
      if (!r.headers.cookie) { (s as unknown as { statusCode: number }).statusCode = 401; return; }
      await gate;
    });

    // Fill the slot and the whole queue, so any slot-taking request is refused.
    const held = [route(req(), mockRes()), route(req(), mockRes()), route(req(), mockRes())];
    await settle();
    expect(renderSlotStats()).toEqual({ active: 1, queued: 2 });

    const res = mockRes();
    await route({ method: 'GET', url: '/x', headers: {} } as unknown as NextApiRequest, res);
    // Not a 503: it never asked for a slot, and the semaphore is untouched.
    expect(res.statusCode).toBe(401);
    expect(renderSlotStats()).toEqual({ active: 1, queued: 2 });

    release();
    await Promise.all(held);
    expect(seen).toContain('none');
  });

  it('releases the slot when the wrapped handler throws', async () => {
    process.env.PDF_MAX_CONCURRENT_RENDERS = '1';
    const route = withRenderSlot(async () => { throw new Error('handler blew up'); });
    await expect(route(req(), mockRes())).rejects.toThrow('handler blew up');
    expect(renderSlotStats()).toEqual({ active: 0, queued: 0 });
  });
});
