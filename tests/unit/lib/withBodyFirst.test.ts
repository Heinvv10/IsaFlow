/**
 * withBodyFirst's own bounds, without a database (round 5): a user's read slot and received bytes
 * are held until the wrapped handler finishes (not only until the read does); a user holds at most
 * one route maxBytes in flight; small bodies (<= 1 MB) have a lane outside the process budget, so
 * large uploads filling it never starve a normal grid save; and a rate bucket that throws is a
 * clean 503, logged. Real streams; the session token is signed with a stubbed JWT_SECRET (aal2, so
 * verifyToken never calls GoTrue).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { SignJWT } from 'jose';
import type { NextApiHandler } from 'next';
import { log } from '@/lib/logger';
import { earlyReadStats, earlySmallLaneBytes, takeRawBody, withBodyFirst } from '@/lib/readJsonBody';

const MB = 1048576;
const CSRF = 'c'.repeat(40);
const LIMITS = { maxBytes: 18 * MB, totalMs: 60_000, idleMs: 10_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { vi.stubEnv('JWT_SECRET', 'unit-test-secret-unit-test-secret-0123'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const tokenFor = (sub: string) => new SignJWT({ role: 'authenticated', aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setSubject(sub)
  .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

/** A body that sends `bytes` at once, then holds (until `release()`) before it ends. */
function holding(bytes: number) {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const stream = Readable.from((async function* gen() {
    for (let sent = 0; sent < bytes; sent += MB) yield Buffer.alloc(Math.min(MB, bytes - sent), 0x20);
    await released;
  })());
  return { stream, release };
}

/** Calls `handler` as user `sub` with `stream` as the body; resolves with the status, code and Retry-After. */
async function call(handler: NextApiHandler, sub: string, stream: Readable, declared?: number) {
  const token = await tokenFor(sub);
  const req = Object.assign(stream, {
    method: 'POST', url: '/api/test', query: {},
    cookies: { isaflow_csrf: CSRF, 'sb-access-token': token },
    headers: { cookie: `isaflow_csrf=${CSRF}; sb-access-token=${token}`, 'x-csrf-token': CSRF, ...(declared === undefined ? {} : { 'content-length': String(declared) }) },
  });
  const headers = new Map<string, string>();
  const state = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    setHeader(k: string, v: string) { headers.set(k.toLowerCase(), v); return this; },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
    json(b: unknown) { state.body = b; return this; },
    end() { return this; },
  };
  await handler(req as never, res as never);
  const code = (state.body as { error?: { code?: string; details?: { code?: string } } } | undefined)?.error;
  return { status: state.status, code: code?.details?.code ?? code?.code, retryAfter: headers.get('retry-after') };
}

/** An inner handler that takes the early bytes and answers 200 once `open()` is called. */
function gatedInner() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  const inner: NextApiHandler = async (req, res) => {
    await takeRawBody(req);
    await opened;
    res.status(200).json({ ok: true });
  };
  return { inner, open };
}

describe('withBodyFirst bounds', () => {
  it("a user's read slot and bytes are held until the wrapped handler finishes", async () => {
    const { inner, open } = gatedInner();
    const pending = call(withBodyFirst(LIMITS, inner), 'u-hold', Readable.from([Buffer.alloc(2 * MB, 0x20)]));
    for (let i = 0; i < 200 && earlyReadStats().reads === 0; i++) await sleep(5);
    await sleep(50);
    const during = earlyReadStats();
    open();
    expect((await pending).status).toBe(200);
    expect(during).toEqual({ reads: 1, bytes: 2 * MB });
    expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
  });

  it('one user holds at most the route maxBytes in flight: a second upload past it is 429', async () => {
    const small = { ...LIMITS, maxBytes: 3 * MB };
    const { inner, open } = gatedInner();
    const first = call(withBodyFirst(small, inner), 'u-cap', Readable.from([Buffer.alloc(2 * MB, 0x20)]));
    for (let i = 0; i < 200 && earlyReadStats().bytes < 2 * MB; i++) await sleep(5);
    const second = await call(withBodyFirst(small, inner), 'u-cap', Readable.from([Buffer.alloc(2 * MB, 0x20)]));
    open();
    await first;
    expect([second.status, second.code, second.retryAfter]).toEqual([429, 'EARLY_READ_USER_BUDGET', '5']);
  });

  it('with the 64 MB process budget full of large uploads, a small body (<= 1 MB) is still read', async () => {
    const big = [1, 2, 3, 4].map(() => holding(16 * MB));
    const { inner, open } = gatedInner();
    const pending = big.map((b, i) => call(withBodyFirst(LIMITS, inner), `u-big-${i}`, b.stream));
    for (let i = 0; i < 400 && earlyReadStats().bytes < 64 * MB; i++) await sleep(5);
    expect(earlyReadStats().bytes).toBe(64 * MB);
    const smallInner: NextApiHandler = async (req, res) => { await takeRawBody(req); res.status(200).json({ ok: true }); };
    const small = await call(withBodyFirst(LIMITS, smallInner), 'u-small', Readable.from([Buffer.from('{"cells":[]}')]));
    const largeToo = await call(withBodyFirst(LIMITS, smallInner), 'u-late', Readable.from([Buffer.alloc(2 * MB, 0x20)]));
    for (const b of big) b.release();
    open();
    await Promise.all(pending);
    expect(small.status).toBe(200);
    expect([largeToo.status, largeToo.code]).toEqual([503, 'EARLY_READ_PROCESS_BUDGET']);
    expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
  });

  it('a rate bucket that throws (its database down) is a logged 503 with Retry-After, the body unread', async () => {
    const error = vi.spyOn(log, 'error');
    const inner = vi.fn();
    const rate = { charge: async () => { throw new Error('rate-limit pool unavailable'); }, retryAfterSecs: 60, message: 'x' };
    const r = await call(withBodyFirst(LIMITS, inner as unknown as NextApiHandler, { rate }), 'u-rate', holding(1024).stream);
    expect([r.status, r.code, r.retryAfter]).toEqual([503, 'SERVICE_UNAVAILABLE', '5']);
    expect(inner).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
  });

  it('a user with both read slots taken is 429 WITHOUT charging the rate bucket', async () => {
    const charged: string[] = [];
    const rate = { charge: async (u: string) => { charged.push(u); return true; }, retryAfterSecs: 60, message: 'x' };
    const [x, y] = [holding(1024), holding(1024)];
    const { inner, open } = gatedInner();
    const handler = withBodyFirst(LIMITS, inner, { rate });
    const pending = [call(handler, 'u-slots', x.stream), call(handler, 'u-slots', y.stream)];
    for (let i = 0; i < 200 && earlyReadStats().reads < 2; i++) await sleep(5);
    const third = await call(handler, 'u-slots', holding(1024).stream);
    x.release(); y.release(); open();
    await Promise.all(pending);
    expect([third.status, third.retryAfter]).toEqual([429, '5']);
    expect(charged).toEqual(['u-slots', 'u-slots']);
  });

  it('the small lane has its own 32 MB ceiling: filled, the next body DECLARED small is 503, while a 2 KB save and a large upload are read', async () => {
    // 32 users each hold a 1 MB body (the largest small one): the small lane is full.
    const smalls = Array.from({ length: 32 }, () => holding(MB));
    const { inner, open } = gatedInner();
    const pending = smalls.map((b, i) => call(withBodyFirst(LIMITS, inner), `u-lane-${i}`, b.stream));
    for (let i = 0; i < 600 && earlySmallLaneBytes() < 32 * MB; i++) await sleep(5);
    expect(earlySmallLaneBytes()).toBe(32 * MB);
    const plain: NextApiHandler = async (req, res) => { await takeRawBody(req); res.status(200).json({ ok: true }); };
    const nextSmall = await call(withBodyFirst(LIMITS, plain), 'u-lane-next', Readable.from([Buffer.alloc(100 * 1024, 0x20)]), 100 * 1024);
    const tiny = await call(withBodyFirst(LIMITS, plain), 'u-lane-tiny', Readable.from([Buffer.alloc(2 * 1024, 0x20)]));
    const large = await call(withBodyFirst(LIMITS, plain), 'u-lane-large', Readable.from([Buffer.alloc(2 * MB, 0x20)]));
    for (const b of smalls) b.release();
    open();
    await Promise.all(pending);
    expect([nextSmall.status, nextSmall.code, nextSmall.retryAfter]).toEqual([503, 'EARLY_READ_PROCESS_BUDGET', '5']);
    expect([tiny.status, large.status]).toEqual([200, 200]);
    expect([earlySmallLaneBytes(), earlyReadStats()]).toEqual([0, { reads: 0, bytes: 0 }]);
  });

  it('a body declared tiny counts against no lane until it passes 64 KB, then moves to the small lane', async () => {
    let more = () => {};
    const sendMore = new Promise<void>((resolve) => { more = resolve; });
    let end = () => {};
    const ended = new Promise<void>((resolve) => { end = resolve; });
    const stream = Readable.from((async function* gen() {
      yield Buffer.alloc(32 * 1024, 0x20);
      await sendMore;
      yield Buffer.alloc(200 * 1024, 0x20);
      await ended;
    })());
    const { inner, open } = gatedInner();
    const token = await tokenFor('u-moves');
    const req = Object.assign(stream, {
      method: 'POST', url: '/api/test', query: {}, cookies: { isaflow_csrf: CSRF, 'sb-access-token': token },
      headers: { cookie: `isaflow_csrf=${CSRF}; sb-access-token=${token}`, 'x-csrf-token': CSRF, 'content-length': '1024' },
    });
    const res = { status() { return this; }, setHeader() { return this; }, json() { return this; }, end() { return this; } };
    const pending = withBodyFirst(LIMITS, inner)(req as never, res as never);
    for (let i = 0; i < 200 && earlyReadStats().reads === 0; i++) await sleep(5);
    await sleep(50);
    const asTiny = earlySmallLaneBytes();
    more();
    for (let i = 0; i < 200 && earlySmallLaneBytes() === 0; i++) await sleep(5);
    const moved = earlySmallLaneBytes();
    end();
    open();
    await pending;
    expect([asTiny, moved]).toEqual([0, 232 * 1024]);
  });

  describe('lane migration of an undeclared body', () => {
    /** An undeclared body sent in 256 KB chunks up to `bytes`, then held until release(). */
    const chunked = (bytes: number) => {
      let release = () => {};
      const released = new Promise<void>((resolve) => { release = resolve; });
      const stream = Readable.from((async function* gen() {
        for (let sent = 0; sent < bytes; sent += 256 * 1024) yield Buffer.alloc(256 * 1024, 0x20);
        await released;
      })());
      return { stream, release };
    };

    it('tiny -> small -> large: mid-read the 2 MB are all in the large lane and none in the small lane; afterwards both are 0', async () => {
      const body = chunked(2 * MB);
      const { inner, open } = gatedInner();
      const pending = call(withBodyFirst(LIMITS, inner), 'u-mig', body.stream);
      for (let i = 0; i < 400 && earlyReadStats().bytes < 2 * MB; i++) await sleep(5);
      const mid = [earlySmallLaneBytes(), earlyReadStats().bytes];
      body.release();
      open();
      expect((await pending).status).toBe(200);
      expect(mid).toEqual([0, 2 * MB]);
      expect([earlySmallLaneBytes(), earlyReadStats()]).toEqual([0, { reads: 0, bytes: 0 }]);
    });

    it('a refused migration (the large lane full) is 503 and gives its small-lane bytes back', async () => {
      const big = [1, 2, 3, 4].map(() => holding(16 * MB));
      const { inner, open } = gatedInner();
      const holders = big.map((b, i) => call(withBodyFirst(LIMITS, inner), `u-mig-full-${i}`, b.stream));
      for (let i = 0; i < 400 && earlyReadStats().bytes < 64 * MB; i++) await sleep(5);
      const body = chunked(2 * MB);
      const refused = await call(withBodyFirst(LIMITS, inner), 'u-mig-refused', body.stream);
      body.release();
      const smallAfterRefusal = earlySmallLaneBytes();
      for (const b of big) b.release();
      open();
      await Promise.all(holders);
      expect([refused.status, refused.code]).toEqual([503, 'EARLY_READ_PROCESS_BUDGET']);
      expect(smallAfterRefusal).toBe(0);
      expect(earlyReadStats()).toEqual({ reads: 0, bytes: 0 });
    });

    it('with the small lane full, an undeclared large body in 256 KB chunks goes to the large lane instead of 503', async () => {
      const smalls = Array.from({ length: 32 }, () => holding(MB));
      const { inner, open } = gatedInner();
      const holders = smalls.map((b, i) => call(withBodyFirst(LIMITS, inner), `u-mig-small-${i}`, b.stream));
      for (let i = 0; i < 600 && earlySmallLaneBytes() < 32 * MB; i++) await sleep(5);
      const plain: NextApiHandler = async (req, res) => { await takeRawBody(req); res.status(200).json({ ok: true }); };
      const body = Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(256 * 1024, 0x20)));
      const r = await call(withBodyFirst(LIMITS, plain), 'u-mig-overflow', body);
      for (const b of smalls) b.release();
      open();
      await Promise.all(holders);
      expect(r.status).toBe(200);
      expect([earlySmallLaneBytes(), earlyReadStats()]).toEqual([0, { reads: 0, bytes: 0 }]);
    });
  });
});
