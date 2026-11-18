/**
 * Match changes both rows or neither (999r row security lets a user change an intercompany row only with a write role
 * in its source or target company). A group writer who writes neither party of one row used to get "matched" with 0 or 1
 * row changed; now the UPDATE is rolled back and IntercompanyMatchRefusedError is thrown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql, withTransaction } from '@/lib/neon';
import { IntercompanyMatchRefusedError, matchIntercompanyTransactions } from '@/modules/accounting/services/reports/intercompanyService';
import { log } from '@/lib/logger';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockTx = vi.fn();
const G = '80000000-0000-4000-8000-000000000001';
const T1 = '60000000-0000-4000-8000-000000000001';
const T2 = '60000000-0000-4000-8000-000000000002';

/** Like the real withTransaction: the callback's throw rolls back (here: the writes it made are discarded). */
let rolledBack = false;

beforeEach(() => {
  mockSql.mockReset();
  mockTx.mockReset();
  rolledBack = false;
  vi.mocked(withTransaction).mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => {
    try { return await fn(mockTx); } catch (e) { rolledBack = true; throw e; }
  }) as never);
  mockSql.mockResolvedValueOnce([{ id: T1, amount: 10 }]).mockResolvedValueOnce([{ id: T2, amount: 10 }]);
  vi.mocked(log.info).mockClear();
});

describe('matchIntercompanyTransactions: both rows or neither', () => {
  it('both rows changed: succeeds and logs the match', async () => {
    mockTx.mockResolvedValueOnce([{ id: T1 }, { id: T2 }]);
    await expect(matchIntercompanyTransactions(T1, T2, G)).resolves.toBeUndefined();
    expect(rolledBack).toBe(false);
    expect(log.info).toHaveBeenCalledWith('Intercompany transactions matched', expect.anything(), 'accounting');
  });

  it.each([
    ['one row changed (the writer writes only one pair)', [{ id: T1 }], 1],
    ['no row changed (the writer writes neither pair)', [], 0],
  ] as const)('%s: refused, rolled back, no "matched" logged', async (_n, returned, changed) => {
    mockTx.mockResolvedValueOnce([...returned]);
    const err = await matchIntercompanyTransactions(T1, T2, G).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntercompanyMatchRefusedError);
    expect(err).toMatchObject({ expected: 2, changed });
    expect(rolledBack).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('the UPDATE asks for both ids in this group and returns the ids it changed', async () => {
    mockTx.mockResolvedValueOnce([{ id: T1 }, { id: T2 }]);
    await matchIntercompanyTransactions(T1, T2, G);
    const [strings, ...values] = mockTx.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/RETURNING id/);
    expect(values).toEqual(expect.arrayContaining([T1, T2, G]));
  });
});
