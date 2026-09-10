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
  deferredTaxRate: 27,
};

/** Text-keyed sql mock — robust to query insertions between versions. */
function mockByText(overrides: Record<string, unknown[] | Error> = {}) {
  mockSql.mockImplementation((strings: TemplateStringsArray) => {
    const text = (strings as unknown as string[]).join('?');
    for (const [pattern, result] of Object.entries(overrides)) {
      if (new RegExp(pattern, 'i').test(text)) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }
    }
    if (/SELECT id, asset_number/i.test(text)) {
      return Promise.resolve([{ id: ASSET_ID, asset_number: 'ASST-0001', name: 'X' }]);
    }
    return Promise.resolve([]); // apl upsert, existing-check (no hit), lines, updates
  });
}

describe('postDualDepreciationToLedger atomicity (PR #200)', () => {
  beforeEach(() => {
    savepointCalls.length = 0;
    vi.resetAllMocks(); // reset, not clear: once-queues must not leak across tests
  });

  it('runs ledger upsert + GL post inside ONE savepoint and reports success', async () => {
    mockByText({ 'INSERT INTO gl_journal_entries': [{ id: 'je-1' }] });

    const result = await postDualDepreciationToLedger(
      COMPANY_ID, ASSET_ID, input, '202607', USER_ID,
    );

    expect(savepointCalls).toContain('asset_dep_period');
    expect(result.glFailed).toBe(false);
    expect(result.entryId).toBe('je-1');

    // Everything ran INSIDE the savepoint (after withSavepoint was entered), and
    // the asset row lock is taken BEFORE the upsert. Deriving the tax opening
    // without that lock is what let two concurrent runs for different periods
    // both read the same balance and drop one period's charge.
    const texts = mockSql.mock.calls.map((c) => (c[0] as string[]).join('?'));
    const lockAt = texts.findIndex((t) => /FOR UPDATE/i.test(t));
    const upsertAt = texts.findIndex((t) => /INSERT INTO asset_period_ledger/i.test(t));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(upsertAt).toBeGreaterThan(lockAt);
  });

  it('reports glFailed=true when the GL post throws — nothing silently persists', async () => {
    mockByText({
      'INSERT INTO gl_journal_entries': Object.assign(new Error('value too long'), { code: '22001' }),
    });


    const result = await postDualDepreciationToLedger(
      COMPANY_ID, ASSET_ID, input, '202607', USER_ID,
    );

    expect(result.glFailed).toBe(true);
    expect(result.entryId).toBeNull();
    expect(savepointCalls).toContain('asset_dep_period');
  });

  it('returns the existing journal as already-posted on a same-month re-run (idempotent)', async () => {
    mockByText({
      'SELECT id FROM gl_journal_entries': [{ id: 'je-existing' }],
      'INSERT INTO gl_journal_entries': new Error('must not re-insert when already posted'),
    });

    const result = await postDualDepreciationToLedger(
      COMPANY_ID, ASSET_ID, input, '202607', USER_ID,
    );

    expect(result.glFailed).toBe(false);
    expect(result.entryId).toBe('je-existing');
  });

  it('a REVERSED same-month entry is NOT treated as already-posted — the re-run fails LOUD', async () => {
    // The idempotency SELECT filters reversed_at IS NULL, so a reversed
    // original is invisible to it; the INSERT then hits the unique index
    // (number still taken by the reversed row) → savepoint → glFailed:true.
    // Silent success here would permanently under-depreciate the asset
    // (reversal never touches assets.accumulated_depreciation).
    const idempotencySql = mockSql; // alias for clarity
    mockByText({
      'SELECT id FROM gl_journal_entries': [], // reversed row filtered out
      'INSERT INTO gl_journal_entries': Object.assign(
        new Error('duplicate key value violates unique constraint "uq_gl_je_company_entry_number"'),
        { code: '23505' },
      ),
    });

    const result = await postDualDepreciationToLedger(
      COMPANY_ID, ASSET_ID, input, '202607', USER_ID,
    );

    expect(result.glFailed).toBe(true);
    expect(result.entryId).toBeNull();
    const existingCheck = idempotencySql.mock.calls
      .map((c) => (c[0] as unknown as string[]).join('?'))
      .find((t) => /SELECT id FROM gl_journal_entries/i.test(t));
    expect(existingCheck, 'idempotency check must exclude reversed entries').toMatch(
      /reversed_at IS NULL/i,
    );
  });
});
