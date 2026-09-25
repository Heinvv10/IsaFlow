/**
 * The split must put the base on EVERY companion VAT Input line, and a
 * companion's reversal must carry it to EVERY partner line: a line left without
 * its base would let a claim escape the claim period's 15% check. Either
 * mismatch is a fault — a plain Error, so the savepoint rolls the work back.
 *
 * Mutation note: removing either count check (the `written !== taxLines.length`
 * or the `copied.length !== expected` comparison) turns the matching "throws"
 * test below red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queue: unknown[][] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => queue.shift() ?? []),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { copyLateClaimBaseToReversal, writeLateClaimBases } from '@/modules/accounting/services/gl/vatLateClaimSplit';

const line = (base: number) => ({ glAccountId: 'vin', amount: 15, vatType: 'standard', base });

describe('late-claim base writes are verified', () => {
  beforeEach(() => { queue.length = 0; });

  it('writeLateClaimBases passes when every planned line took its base', async () => {
    queue.push([{ id: 'l1' }], [{ id: 'l2' }]);
    await expect(writeLateClaimBases('co', 'comp', [line(100), line(100)])).resolves.toBeUndefined();
  });

  it('writeLateClaimBases THROWS when a planned line found no row to take its base', async () => {
    queue.push([{ id: 'l1' }], []);
    await expect(writeLateClaimBases('co', 'comp', [line(100), line(100)]))
      .rejects.toThrow('the base was written on 1 of 2 VAT Input lines');
  });

  it('copyLateClaimBaseToReversal passes when every based line found its partner', async () => {
    queue.push([{ n: 2 }], [{ id: 'r1' }, { id: 'r2' }]);
    await expect(copyLateClaimBaseToReversal('co', 'comp', 'rev')).resolves.toBeUndefined();
  });

  it('copyLateClaimBaseToReversal THROWS when a based line found no partner', async () => {
    queue.push([{ n: 2 }], [{ id: 'r1' }]);
    await expect(copyLateClaimBaseToReversal('co', 'comp', 'rev'))
      .rejects.toThrow('the base was carried to 1 of 2 lines');
  });
});
