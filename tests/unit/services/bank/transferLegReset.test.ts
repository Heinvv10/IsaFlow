/**
 * WP2 row 10 (#1518 review LOW 6): a leg matched to the journal AFTER the peek — so not in the set locked with the
 * reversed line — is a retryable refusal before any write (the route answers it as contention), never reset unlocked
 * nor left allocated to the reversed journal. Unit-level: the window between the peek and the re-read under the locks
 * is one statement wide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { losing } = vi.hoisted(() => ({ losing: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/liveBankLineReversal', () => ({ liveLinesLosingCash: losing }));
vi.mock('@/modules/accounting/services/bank/reversalDatePostable', () => ({ peekReversalTarget: vi.fn(async () => 'head') }));
vi.mock('@/modules/accounting/services/bank/reconciledCash', () => ({
  reconciliationLockOf: vi.fn(async () => null), refuseLockedCash: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  lockBankTransactionsInIdOrder: vi.fn(async (_c: string, ids: string[]) => ids.map((id) => ({ id, status: 'allocated' }))),
}));

import { lockOtherLegs, takeOtherLegs } from '@/modules/accounting/services/bank/transferLegReset';
import { isBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';

const CHAIN = { lineId: 'l', journalId: 'j', rootId: 'j', doc: null };

describe('takeOtherLegs', () => {
  beforeEach(() => { losing.mockReset(); });

  it('a leg that appeared after the peek is a retryable refusal', async () => {
    losing.mockResolvedValueOnce(['me', 'b']).mockResolvedValueOnce(['me', 'b', 'late']);
    const locked = await lockOtherLegs('co', 'me', CHAIN, false);
    const err = await takeOtherLegs('co', 'me', CHAIN, locked, false).then(() => null, (e: unknown) => e);
    expect(isBankAllocationRefusal(err)).toBe(true);
    expect((err as { retryable?: boolean }).retryable).toBe(true);
    expect((err as Error).message).toMatch(/matched to this journal while it was being reversed — retry/);
  });

  it('the legs locked with the line come back as rows; the page\'s Undo takes none', async () => {
    losing.mockResolvedValue(['me', 'b']);
    const locked = await lockOtherLegs('co', 'me', CHAIN, false);
    expect((await takeOtherLegs('co', 'me', CHAIN, locked, false)).map((r) => r.id)).toEqual(['b']);
    expect(await takeOtherLegs('co', 'me', CHAIN, locked, true)).toEqual([]);
  });
});
