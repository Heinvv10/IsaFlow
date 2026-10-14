/**
 * Whole-ledger audit jobs: at most MAX_CONCURRENT_SNAPSHOTS at once, at most PER_COMPANY for one company, PER_USER for
 * one person, MAX_AUTOMATIC automatic. By hand the next is refused; automatic ones wait, people in turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_AUTOMATIC, MAX_CONCURRENT_SNAPSHOTS, MAX_WAITING_PER_USER, PER_COMPANY, PER_USER, SLOT_WAIT_MS, withSnapshotSlot } from '@/modules/accounting/services/audit/snapshotSlots';
import { SnapshotBusyError } from '@/modules/accounting/services/audit/auditTx';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('withSnapshotSlot', () => {
  it('one company gets one slot; another company the second; a third waits or is refused', async () => {
    expect([MAX_CONCURRENT_SNAPSHOTS, PER_COMPANY]).toEqual([2, 1]);
    const release: Record<string, () => void> = {};
    const hold = (c: string) => withSnapshotSlot(c, false, () => new Promise<void>((r) => { release[c] = r; }));
    const a = hold('A');
    await tick();
    // Company A already holds its share: refused by hand even though a slot is free; its automatic job waits.
    await expect(withSnapshotSlot('A', false, async () => 'x')).rejects.toBeInstanceOf(SnapshotBusyError);
    let aSecond = false;
    const a2 = withSnapshotSlot('A', true, async () => { aSecond = true; });
    // Company B takes the free slot; C is refused (both slots taken).
    const b = hold('B');
    await tick();
    await expect(withSnapshotSlot('C', false, async () => 'x')).rejects.toBeInstanceOf(SnapshotBusyError);
    let cRan = false;
    const c = withSnapshotSlot('C', true, async () => { cRan = true; });
    // B finishes: C (another company) runs before A's second job, which still waits for A's own slot.
    release.B!();
    await b;
    await c;
    expect([cRan, aSecond]).toEqual([true, false]);
    release.A!();
    await a;
    await a2;
    expect(aSecond).toBe(true);
    expect(await withSnapshotSlot('A', false, async () => 'free')).toBe('free');
  });

  it('one person holds one slot, whichever company: their second company is refused and another person gets the slot (breaker r2 N5)', async () => {
    expect(PER_USER).toBe(1);
    let release = () => {};
    const held = withSnapshotSlot('P1', true, () => new Promise<void>((r) => { release = r; }), 'person');
    await tick();
    await expect(withSnapshotSlot('P2', false, async () => 'x', 'person')).rejects.toBeInstanceOf(SnapshotBusyError);
    expect(await withSnapshotSlot('P3', false, async () => 'other person', 'someone-else')).toBe('other person');
    release();
    await held;
    expect(await withSnapshotSlot('P2', false, async () => 'free', 'person')).toBe('free');
  });

  it('a person\'s automatic jobs queue behind each other, not refused, and at most MAX_WAITING_PER_USER wait (security review)', async () => {
    let release = () => {};
    const held = withSnapshotSlot('W0', true, () => new Promise<void>((r) => { release = r; }), 'bookkeeper');
    await tick();
    const ran: string[] = [];
    const queued = Array.from({ length: MAX_WAITING_PER_USER }, (_, i) =>
      withSnapshotSlot(`W${i + 1}`, true, async () => { ran.push(`W${i + 1}`); }, 'bookkeeper'));
    await expect(withSnapshotSlot('W-over', true, async () => 'x', 'bookkeeper')).rejects.toBeInstanceOf(SnapshotBusyError);
    // Their jobs never hold the second slot together: another person still gets it.
    expect(await withSnapshotSlot('X', false, async () => 'other', 'someone-else')).toBe('other');
    release();
    await held;
    await Promise.all(queued);
    expect(ran).toHaveLength(MAX_WAITING_PER_USER);
  });

  it('automatic jobs hold at most MAX_AUTOMATIC slots: what a person asks for still finds one (breaker r4 L4)', async () => {
    expect(MAX_AUTOMATIC).toBe(1);
    let release = () => {};
    const auto1 = withSnapshotSlot('Q1', true, () => new Promise<void>((r) => { release = r; }), 'u1');
    await tick();
    let auto2Ran = false;
    const auto2 = withSnapshotSlot('Q2', true, async () => { auto2Ran = true; }, 'u2');
    await tick();
    expect(auto2Ran).toBe(false); // a slot is free, but not for a second automatic job
    expect(await withSnapshotSlot('M', false, async () => 'manual', 'u3')).toBe('manual');
    release();
    await auto1;
    await auto2;
    expect(auto2Ran).toBe(true);
  });

  it('the automatic queue takes people in turn, not in arrival order (breaker r4 L4)', async () => {
    let release = () => {};
    const holder = withSnapshotSlot('R0', true, () => new Promise<void>((r) => { release = r; }), 'z');
    await tick();
    const order: string[] = [];
    const jobs = [['X1', 'x'], ['X2', 'x'], ['X3', 'x'], ['Y1', 'y']].map(([c, u]) =>
      withSnapshotSlot(c!, true, async () => { order.push(c!); await tick(); }, u!));
    release();
    await holder;
    await Promise.all(jobs);
    // x was first in the queue and runs first; then y (not served yet) before x's next jobs.
    expect(order).toEqual(['X1', 'Y1', 'X2', 'X3']);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('an automatic job waits at most SLOT_WAIT_MS behind a holder that hangs, then is refused and leaves the queue', async () => {
    vi.useFakeTimers();
    let release = () => {};
    const hung = withSnapshotSlot('H', true, () => new Promise<void>((r) => { release = r; }));
    let ran = false;
    const waiter = withSnapshotSlot('H', true, async () => { ran = true; }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SLOT_WAIT_MS - 1);
    expect(ran).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiter).toBeInstanceOf(SnapshotBusyError);
    // It left the queue: the hung holder's release does not run it, and the slot is free again afterwards.
    release();
    await hung;
    expect(ran).toBe(false);
    expect(await withSnapshotSlot('H', false, async () => 'free')).toBe('free');
  });
});
