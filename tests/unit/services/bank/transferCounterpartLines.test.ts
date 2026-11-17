/**
 * reverseFreeingTransferCounterparts: the batch / range reversal frees a transfer's other bank line (auto-linked to
 * the same journal, outside the batch) with the line it reverses, and refuses before any write when a reconciliation
 * holds that line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/modules/accounting/services/bank/bankTxLock', () => ({
  lockBankTransactionForUpdate: vi.fn(),
  lockBankTransactionsInIdOrder: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/reconciledCash', () => ({
  reconciliationLockOf: vi.fn(),
  refuseLockedCash: (lock: unknown) => { if (lock) throw new Error('locked cash'); },
}));
vi.mock('@/modules/accounting/services/bank/bankChainLineReversal', () => ({ resetBankLine: vi.fn() }));

import { lockBankTransactionForUpdate, lockBankTransactionsInIdOrder } from '@/modules/accounting/services/bank/bankTxLock';
import { reconciliationLockOf } from '@/modules/accounting/services/bank/reconciledCash';
import { resetBankLine } from '@/modules/accounting/services/bank/bankChainLineReversal';
import { reverseFreeingTransferCounterparts } from '@/modules/accounting/services/bank/transferCounterpartLines';

const CO = '00000000-0000-0000-0000-000000000001';
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const JE = '00000000-0000-0000-0000-0000000000e1';

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValue([{ id: B }]);
  vi.mocked(lockBankTransactionsInIdOrder).mockResolvedValue([{ id: B, status: 'allocated', matched_journal_line_id: 'l2' }]);
  vi.mocked(reconciliationLockOf).mockResolvedValue(null);
});

describe('reverseFreeingTransferCounterparts', () => {
  it("resets the transfer's other bank line after the reversal", async () => {
    vi.mocked(lockBankTransactionForUpdate).mockResolvedValue({ id: A, allocation_type: 'transfer' });
    const order: string[] = [];
    vi.mocked(resetBankLine).mockImplementation(async (_c, id) => { order.push(`reset:${id}`); });
    await reverseFreeingTransferCounterparts(CO, A, JE, async (id) => { order.push(`reverse:${id}`); });
    expect(order).toEqual([`reverse:${A}`, `reset:${B}`]);
    expect(resetBankLine).toHaveBeenCalledWith(CO, B, false);
  });

  it('refuses before reversing when a reconciliation holds the other line', async () => {
    vi.mocked(lockBankTransactionForUpdate).mockResolvedValue({ id: A, allocation_type: 'transfer' });
    vi.mocked(reconciliationLockOf).mockResolvedValue({ kind: 'session' } as never);
    const reverse = vi.fn();
    await expect(reverseFreeingTransferCounterparts(CO, A, JE, reverse)).rejects.toThrow('locked cash');
    expect(reverse).not.toHaveBeenCalled();
    expect(resetBankLine).not.toHaveBeenCalled();
  });

  it('leaves a non-transfer line to the reversal alone', async () => {
    vi.mocked(lockBankTransactionForUpdate).mockResolvedValue({ id: A, allocation_type: 'account' });
    const reverse = vi.fn().mockResolvedValue(undefined);
    await reverseFreeingTransferCounterparts(CO, A, JE, reverse);
    expect(reverse).toHaveBeenCalledWith(A);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(resetBankLine).not.toHaveBeenCalled();
  });
});
