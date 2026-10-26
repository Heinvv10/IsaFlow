/**
 * CpuSlot / withCpuSlot (budgets P2 PR-B round 9, R5): at most `max` run at once, at most `queue`
 * wait, a waiter gives up after `waitMs`, and a refusal never runs the work. Asserted by order and
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

  it('a request with no session cookie skips the slot; one without a slot is a 503 with Retry-After', async () => {
    const slot = new CpuSlot('t', 1, 0, 60_000);
    const g = gate();
    let calls = 0;
    const route = withCpuSlot(slot, async () => { calls++; await g.opened; });
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
