/**
 * postDualDepreciationToLedger atomicity (PR #200 review HIGH).
 *
 * The asset_period_ledger upsert and the GL posting must commit or roll back
 * TOGETHER inside one savepoint: a persisted subledger period row without its
 * backing journal permanently understates accumulated depreciation (the next
 * run computes from persisted opening balances). A GL failure must surface as
 * glFailed=true so the run can report it loudly — never a silent partial.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

const savepointCalls: string[] = [];

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn(async (name: string, fn: () => unknown) => {
      savepointCalls.push(name);
      return fn();
    }),
    fmtDate: (d: unknown) => String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn().mockResolvedValue('acct-1'),
}));

import { sql } from '@/lib/neon';
import { postDualDepreciationToLedger } from '@/modules/accounting/services/gl/glCrossModuleHooks';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const ASSET_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

const input = {
  cost: 12000,
  residualPct: 0,
  usefulLifeYears: 3,
  taxLifeYears: 3,
  purchaseDate: '2026-01-01',
  periodDate: '2026-07-31',
  openingAccDep: 0,
  taxOpeningAccDep: 0,
  deferredTaxRate: 27,
};

describe('postDualDepreciationToLedger atomicity (PR #200)', () => {
  beforeEach(() => {
    savepointCalls.length = 0;
    vi.clearAllMocks();
  });

  it('runs ledger upsert + GL post inside ONE savepoint and reports success', async () => {
    // upsert → [], asset SELECT → row, entry INSERT → id, 2 line INSERTs, asset UPDATE
    mockSql
      .mockResolvedValueOnce([]) // apl upsert
      .mockResolvedValueOnce([{ id: ASSET_ID, asset_number: 'ASST-0001', name: 'X' }])
      .mockResolvedValueOnce([{ id: 'je-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await postDualDepreciationToLedger(
      COMPANY_ID, ASSET_ID, input, '202607', USER_ID,
    );

    expect(savepointCalls).toContain('asset_dep_period');
    expect(result.glFailed).toBe(false);
    expect(result.entryId).toBe('je-1');

    // The apl upsert ran INSIDE the savepoint (after withSavepoint was entered).
    const upsertText = (mockSql.mock.calls[0]![0] as string[]).join('?');
    expect(upsertText).toMatch(/INSERT INTO asset_period_ledger/i);
  });

  it('reports glFailed=true when the GL post throws — nothing silently persists', async () => {
    mockSql
      .mockResolvedValueOnce([]) // apl upsert (rolled back by the savepoint in prod)
      .mockResolvedValueOnce([{ id: ASSET_ID, asset_number: 'ASST-0001', name: 'X' }])
      .mockRejectedValueOnce(Object.assign(new Error('value too long'), { code: '22001' }));

    const result = await postDualDepreciationToLedger(
      COMPANY_ID, ASSET_ID, input, '202607', USER_ID,
    );

    expect(result.glFailed).toBe(true);
    expect(result.entryId).toBeNull();
    expect(savepointCalls).toContain('asset_dep_period');
  });
});
