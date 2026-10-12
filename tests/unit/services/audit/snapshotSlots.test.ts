/**
 * Whole-ledger audit jobs: at most MAX_CONCURRENT_SNAPSHOTS at once, at most PER_COMPANY for one company. By hand the
 * next is refused; automatic ones wait — and one company cannot hold every slot.
 */
import { describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_SNAPSHOTS, PER_COMPANY, withSnapshotSlot } from '@/modules/accounting/services/audit/snapshotSlots';
import { SnapshotBusyError } from '@/modules/accounting/services/audit/auditTx';

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
});
