/**
 * Whole-ledger audit jobs: at most MAX_CONCURRENT_SNAPSHOTS at once, at most PER_COMPANY for one company. By hand the
 * next is refused; automatic ones wait — and one company cannot hold every slot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_CONCURRENT_SNAPSHOTS, PER_COMPANY, PER_USER, withSnapshotSlot } from '@/modules/accounting/services/audit/snapshotSlots';
import { AUDIT_WAIT_MS, SnapshotBusyError } from '@/modules/accounting/services/audit/auditTx';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('withSnapshotSlot', () => {
  it('one company gets one slot; another company the second; a third waits or is refused', async () => {
    expect([MAX_CONCURRENT_SNAPSHOTS, PER_COMPANY]).toEqual([2, 1]);
    const release: Record<string, () => void> = {};
    const hold = (c: string) => withSnapshotSlot(c, true, () => new Promise<void>((r) => { release[c] = r; }));
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

  afterEach(() => { vi.useRealTimers(); });

  it('an automatic job waits at most AUDIT_WAIT_MS behind a holder that hangs, then is refused and leaves the queue', async () => {
    vi.useFakeTimers();
    let release = () => {};
    const hung = withSnapshotSlot('H', true, () => new Promise<void>((r) => { release = r; }));
    let ran = false;
    const waiter = withSnapshotSlot('H', true, async () => { ran = true; }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(AUDIT_WAIT_MS - 1);
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
