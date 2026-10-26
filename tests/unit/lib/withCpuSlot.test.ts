/**
 * CpuSlot / withCpuSlot (budgets P2 PR-B round 9, R5): at most `max` run at once, at most `queue`
 * wait, a waiter gives up after `waitMs`, and a refusal never runs the work. Final batch: one
 * owner (user) holds at most `perOwner` places, running or waiting (L6: 429 past it), and a waiter
 * whose client has gone when its turn comes is skipped, its slot passed on (L7). Asserted by order and
 * counts (the slot's own `stats()`), not by wall-clock, except the one wait bound (a few ms).
 */
import { describe, it, expect } from 'vitest';
import { CpuSlot, CpuSlotBusyError, withCpuSlot } from '@/lib/withCpuSlot';

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('CpuSlot', () => {
  it('runs at most `max` at once; the next waits and runs when one finishes', async () => {
    const slot = new CpuSlot('t', 2, 4, 60_000);
    const g = [gate(), gate(), gate()];
    const order: string[] = [];
    const runs = g.map((x, i) => slot.run(async () => { order.push(`start ${i}`); await x.opened; order.push(`end ${i}`); }));
    await tick();
    expect(slot.stats()).toEqual({ running: 2, waiting: 1 });
    expect(order).toEqual(['start 0', 'start 1']);
    g[0]!.open();
    await runs[0];
    await tick();
    expect(order).toEqual(['start 0', 'start 1', 'end 0', 'start 2']);
    expect(slot.stats()).toEqual({ running: 2, waiting: 0 });
    g[1]!.open(); g[2]!.open();
    await Promise.all(runs);
    expect(slot.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('refuses at once, without running the work, when the queue is full', async () => {
    const slot = new CpuSlot('t', 1, 1, 60_000);
    const g = gate();
    const first = slot.run(() => g.opened);
    const second = slot.run(async () => undefined);
    await tick();
    let ran = false;
    await expect(slot.run(async () => { ran = true; })).rejects.toMatchObject({ name: 'CpuSlotBusyError', reason: 'queue-full' });
    expect(ran).toBe(false);
    g.open();
    await Promise.all([first, second]);
    expect(slot.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('a waiter gives up after waitMs, leaves the queue, and the slot is still whole', async () => {
    const slot = new CpuSlot('t', 1, 4, 20);
    const g = gate();
    const first = slot.run(() => g.opened);
    let ran = false;
    await expect(slot.run(async () => { ran = true; })).rejects.toBeInstanceOf(CpuSlotBusyError);
    expect(ran).toBe(false);
    expect(slot.stats()).toEqual({ running: 1, waiting: 0 });
    g.open();
    await first;
    await slot.run(async () => undefined);
    expect(slot.stats()).toEqual({ running: 0, waiting: 0 });
  });

  it('a failing job frees its slot', async () => {
    const slot = new CpuSlot('t', 1, 1, 60_000);
    await expect(slot.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(slot.stats()).toEqual({ running: 0, waiting: 0 });
  });
});

describe('withCpuSlot', () => {
  const res = () => {
    const out = { status: 0, headers: {} as Record<string, string>, body: undefined as unknown };
    const r = {
      setHeader: (k: string, v: string) => { out.headers[k] = v; },
      status: (s: number) => { out.status = s; return r; },
      json: (b: unknown) => { out.body = b; return r; },
    };
    return { out, r };
  };
  const req = (cookie?: string) => ({ url: '/x', headers: cookie ? { cookie } : {}, cookies: cookie ? { 'sb-access-token': 't' } : {} });

  it('a request with no session cookie (or one that does not verify) skips the slot; one without a slot is a 503 with Retry-After', async () => {
    const slot = new CpuSlot('t', 1, 0, 60_000);
    const g = gate();
    let calls = 0;
    const route = withCpuSlot(slot, async () => { calls++; await g.opened; }, async () => ({ sub: 'u' }));
    const holding = route(req('sb-access-token=t') as never, res().r as never);
    await tick();
    const busy = res();
    await route(req('sb-access-token=t') as never, busy.r as never);
    expect([busy.out.status, busy.out.headers['Retry-After'], calls]).toEqual([503, '5', 1]);
    const anonymous = route(req() as never, res().r as never); // no cookie: straight through, no slot
    await tick();
    expect(calls).toBe(2);
    g.open();
    await Promise.all([holding, anonymous]);
  });
});

describe('L6: one owner holds at most perOwner places', () => {
  it('a third place for the same owner is refused (owner-limit) while another owner still gets one', async () => {
    const slot = new CpuSlot('t', 2, 4, 60_000, 2);
    const g = gate();
    const mine = [slot.run(() => g.opened, 'u1'), slot.run(() => g.opened, 'u1')];
    await tick();
    let ran = false;
    await expect(slot.run(async () => { ran = true; }, 'u1')).rejects.toMatchObject({ name: 'CpuSlotBusyError', reason: 'owner-limit' });
    expect(ran).toBe(false);
    const theirs = slot.run(async () => 'ok', 'u2'); // queues (both slots busy), not refused
    await tick();
    expect(slot.stats()).toEqual({ running: 2, waiting: 1 });
    g.open();
    await Promise.all(mine);
    await expect(theirs).resolves.toBe('ok');
    await expect(slot.run(async () => 'again', 'u1')).resolves.toBe('again'); // places given back
  });
});

describe('withCpuSlot: L6 per user, L7 a gone client', () => {
  const token = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
  const res = () => {
    const out = { status: 0, headers: {} as Record<string, string>, ended: false };
    const r = {
      writableEnded: false,
      setHeader: (k: string, v: string) => { out.headers[k] = v; },
      status: (s: number) => { out.status = s; return r; },
      json: () => { out.ended = true; return r; },
    };
    return { out, r };
  };
  const req = (sub: string) => ({ url: '/x', destroyed: false, headers: { cookie: `sb-access-token=${token(sub)}` } });
  const signed = async (t: string) => ({ sub: JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()).sub as string });

  it('L6: a third request from the same user is 429 with Retry-After; another user is not', async () => {
    const slot = new CpuSlot('t', 2, 4, 60_000, 2);
    const g = gate();
    const route = withCpuSlot(slot, async () => { await g.opened; }, signed);
    const running = [route(req('u1') as never, res().r as never), route(req('u1') as never, res().r as never)];
    await tick();
    const third = res();
    await route(req('u1') as never, third.r as never);
    expect([third.out.status, third.out.headers['Retry-After']]).toEqual([429, '5']);
    const other = route(req('u2') as never, res().r as never);
    await tick();
    expect(slot.stats().waiting).toBe(1);
    g.open();
    await Promise.all([...running, other]);
  });

  it('L7: a queued request whose client is gone when its turn comes is skipped, and its slot passes on', async () => {
    const slot = new CpuSlot('t', 1, 4, 60_000, 4);
    const g = gate();
    let calls = 0;
    const route = withCpuSlot(slot, async () => { calls++; await g.opened; }, signed);
    const first = route(req('u1') as never, res().r as never);
    const goneReq = req('u2');
    const gone = route(goneReq as never, res().r as never);
    const last = route(req('u3') as never, res().r as never);
    await tick();
    expect([calls, slot.stats().waiting]).toEqual([1, 2]);
    goneReq.destroyed = true; // the client hung up while queued
    g.open();
    await Promise.all([first, gone, last]);
    expect(calls).toBe(2); // u1 and u3 ran; u2 was skipped
    expect(slot.stats()).toEqual({ running: 0, waiting: 0 });
  });
});
