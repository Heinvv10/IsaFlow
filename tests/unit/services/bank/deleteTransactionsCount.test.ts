/**
 * deleteTransactions must report the number of rows it actually deleted.
 *
 * It previously ran a DELETE with no RETURNING clause and then computed
 * `result.length ?? bankTxIds.length`. lib/neon only ever exposes res.rows —
 * never res.rowCount — so a DELETE without RETURNING resolves to [], and `??`
 * does not fall back on 0. The function therefore returned 0 no matter how
 * many rows went. Two callers report that number to a human:
 * pages/api/accounting/bank-transactions-action.ts and undo_bank_import.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) }),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  transaction: vi.fn(),
  withTransaction: vi.fn(),
  fmtDate: (d: unknown) => String(d ?? ''),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { deleteTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockReset();
});

describe('deleteTransactions', () => {
  it('asks for RETURNING so the driver gives back rows to count', async () => {
    sqlMock.mockResolvedValue([{ id: 'tx-1' }, { id: 'tx-2' }]);

    await deleteTransactions('company-1', ['tx-1', 'tx-2']);

    const text = (sqlMock.mock.calls[0]![0] as unknown as string[]).join('?');
    expect(text).toMatch(/RETURNING/i);
  });

  it('returns the real deleted count, not the count it was asked to delete', async () => {
    // Three ids in, but only two rows were still 'imported' — the SQL filters
    // the third out, so the honest answer is 2.
    sqlMock.mockResolvedValue([{ id: 'tx-1' }, { id: 'tx-2' }]);

    const deleted = await deleteTransactions('company-1', ['tx-1', 'tx-2', 'tx-3-allocated']);

    expect(deleted).toBe(2);
  });

  it('reports 0 when nothing matched rather than inventing the input length', async () => {
    sqlMock.mockResolvedValue([]);

    const deleted = await deleteTransactions('company-1', ['tx-1', 'tx-2']);

    expect(deleted).toBe(0);
  });

  it('scopes the delete by company and refuses anything past imported status', async () => {
    sqlMock.mockResolvedValue([]);

    await deleteTransactions('company-1', ['tx-1']);

    const text = (sqlMock.mock.calls[0]![0] as unknown as string[]).join('?');
    expect(text).toContain('company_id');
    expect(text).toContain("status = 'imported'");
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain('company-1');
  });

  it('short-circuits on an empty id list without touching the database', async () => {
    const deleted = await deleteTransactions('company-1', []);

    expect(deleted).toBe(0);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
