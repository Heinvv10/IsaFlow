/**
 * #1545 review round 2 LOW 1: undoRow peeks the journal's other lines, locks them WITH its row in id order, then re-reads
 * them here. A line matched to the journal after the peek was never locked in that order: a typed RETRYABLE refusal
 * before any write (the undo counts it contended), as transferLegReset.takeOtherLegs answers a late leg.
 */
import { describe, expect, it, vi } from 'vitest';

const { sqlMock, lockMock } = vi.hoisted(() => ({ sqlMock: vi.fn(), lockMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({ lockBankTransactionsInIdOrder: lockMock }));
vi.mock('@/modules/accounting/services/bank/reconciledCash', () => ({ reconciliationLockOf: vi.fn(async () => null) }));

import { lockTransferCounterparts } from '@/modules/accounting/services/bank/transferCounterpartLines';
import { isRetryableBankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';

const TX = { id: 'x', allocation_type: 'transfer' };

describe('lockTransferCounterparts', () => {
  it('a leg found now that the peek did not lock is a retryable refusal, nothing locked', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'y' }, { id: 'late' }]);
    const err = await lockTransferCounterparts('co', TX, 'je', ['y']).then(() => null, (e: unknown) => e);
    expect(isRetryableBankAllocationRefusal(err)).toBe(true);
    expect(lockMock).not.toHaveBeenCalled();
  });

  it('the peeked legs are locked and returned', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'y' }]);
    lockMock.mockResolvedValueOnce([{ id: 'y', status: 'allocated', matched_journal_line_id: 'jl' }]);
    expect(await lockTransferCounterparts('co', TX, 'je', ['Y'])).toEqual({ ids: ['y'], lock: null });
  });
});
