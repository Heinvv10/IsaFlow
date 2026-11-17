/**
 * #1494 rev 6: bankContraLineSkips asks the live duplicate rule (assertNoDuplicateTransfer) once per DISTINCT movement,
 * not once per line — lines of one bank, counterparty, amount, date and evidence share the answer — and only for lines
 * onto another bank account.
 */
import { describe, expect, it, vi } from 'vitest';

const { sqlMock, dup } = vi.hoisted(() => ({ sqlMock: vi.fn(), dup: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/bank/bankContraTransfer', () => ({
  OWN_BANK_CONTRA_MESSAGE: 'own bank', bankAccountsAmong: vi.fn(async () => new Set(['b2'])),
}));
vi.mock('@/modules/accounting/services/bank/transferDuplicateGuard', () => {
  class DuplicateTransferError extends Error {}
  return { DuplicateTransferError, assertNoDuplicateTransfer: dup };
});

import { bankContraLineSkips } from '@/modules/accounting/services/bank/bankContraLineSkips';
import { DuplicateTransferError } from '@/modules/accounting/services/bank/transferDuplicateGuard';

const row = (id: string, amount: number, date = '2026-09-01') =>
  ({ id, bank: 'b1', amount, transaction_date: date, bank_feed_connection_id: null, import_batch_id: 'ib' });

describe('bankContraLineSkips', () => {
  it('reads the duplicate rule once per distinct movement, and skips every line of a duplicate one', async () => {
    sqlMock.mockResolvedValueOnce([row('t1', -100), row('t2', -100), row('t3', -100), row('t4', -250)]);
    dup.mockImplementation(async (_c: string, _b: string, _cp: string, amount: number) => {
      if (amount === -100) throw new DuplicateTransferError('already in the ledger');
    });
    const skips = await bankContraLineSkips('co', ['t1', 't2', 't3', 't4', 't5'].map((txId) => ({ txId, accountId: txId === 't5' ? 'exp' : 'b2' })));
    expect(dup).toHaveBeenCalledTimes(2); // -100 once for three lines, -250 once; t5 is not onto a bank
    expect([...skips]).toEqual([['t1', 'already in the ledger'], ['t2', 'already in the ledger'], ['t3', 'already in the ledger']]);
  });
});
