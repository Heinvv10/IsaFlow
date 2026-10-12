/** At most MAX_CONCURRENT_SNAPSHOTS run at once: by hand the next is refused; automatic ones wait their turn. */
import { describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_SNAPSHOTS, withSnapshotSlot } from '@/modules/accounting/services/audit/snapshotSlots';
import { SnapshotBusyError } from '@/modules/accounting/services/audit/auditTx';

describe('withSnapshotSlot', () => {
  it('refuses a no-wait caller while full; a waiting one runs when a slot frees', async () => {
    expect(MAX_CONCURRENT_SNAPSHOTS).toBe(2);
    const release: (() => void)[] = [];
    const hold = () => withSnapshotSlot(true, () => new Promise<void>((r) => release.push(r)));
    const a = hold();
    const b = hold();
    await Promise.resolve();
    await expect(withSnapshotSlot(false, async () => 'x')).rejects.toBeInstanceOf(SnapshotBusyError);
    let ran = false;
    const c = withSnapshotSlot(true, async () => { ran = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(false);
    release.shift()!();
    await a;
    await c;
    expect(ran).toBe(true);
    release.shift()!();
    await b;
    expect(await withSnapshotSlot(false, async () => 'free')).toBe('free');
  });
});
