/**
 * gl/reversalCleanup.cleanUpAfter (D8 round 16; pinned in round 19, review rev-d8-40bf89737 F2). The real-ledger proof
 * of the 25P02 arm is tests/integration/d8-r16-posting-wait.int.test.ts; these pin the rule's other two arms.
 */
import { describe, expect, it } from 'vitest';
import { cleanUpAfter } from '@/modules/accounting/services/gl/reversalCleanup';

const original = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

describe('cleanUpAfter', () => {
  it('on an aborted transaction (the cleanup gets 25P02) re-throws the ORIGINAL failure', async () => {
    const aborted = Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
    await expect(cleanUpAfter(original, async () => { throw aborted; })).rejects.toBe(original);
  });

  it('any other cleanup failure is thrown as itself — a new fault is not hidden behind the original', async () => {
    const lost = Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' });
    await expect(cleanUpAfter(original, async () => { throw lost; })).rejects.toBe(lost);
    const plain = new Error('claim release refused');
    await expect(cleanUpAfter(original, async () => { throw plain; })).rejects.toBe(plain);
  });

  it('a cleanup that succeeds returns its result', async () => {
    await expect(cleanUpAfter(original, async () => [{ id: 'draft-1' }])).resolves.toEqual([{ id: 'draft-1' }]);
  });
});
