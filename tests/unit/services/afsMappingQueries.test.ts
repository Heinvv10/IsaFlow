/**
 * Unit tests for afsMappingQueries.getMappedTrialBalance
 *
 * Financial-statement correctness guard.
 *
 * The AFS mapped trial balance derived each account's balance from the
 * `gl_account_balances` cache via LEFT JOIN, and the cache was missing rows:
 * its only trigger sat on `gl_journal_lines` and early-returned while the
 * parent entry was still `draft`, with nothing on `gl_journal_entries` to
 * refresh it when the status flipped. 71 (account, period) rows were missing
 * in a real DB, and the LEFT JOIN silently yielded 0.
 *
 * That hole is CLOSED. Migration 499 added `trg_gl_je_status_balance`, which
 * recomputes from posted lines on exactly that transition, both directions.
 * Re-measured against a computed aggregate on 2026-09-03: 2657 rows matched,
 * 0 missing, max absolute drift 0.00. Do not carry the old claim forward — it
 * describes the schema before 499, and re-deriving it is how a fixed bug gets
 * reported as live.
 *
 * The behaviour these tests pin stays, on a reason that does not expire: a
 * financial statement should compute from the ledger, not from an optimisation
 * with two triggers and a fiscal-period key. So the balance query must read
 * posted `gl_journal_lines`, company + period scoped, like every sibling
 * report service.
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getMappedTrialBalance } from '@/modules/accounting/services/afs/afsMappingQueries';

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const FISCAL_PERIOD = 'fp000000-0000-0000-0000-000000000001';
const PRIOR_PERIOD = 'fp000000-0000-0000-0000-000000000000';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

function makeStatementLineRow(code: string) {
  return {
    id: 'line-1', company_id: COMPANY_A, code, section: 'income_statement',
    label: 'Revenue', parent_code: null, note_number: null, sort_order: 1,
    combine_group: null, is_header: false, is_total: false, is_active: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function balanceQueriesOf(calls: unknown[][]): unknown[][] {
  return calls.filter((args) =>
    /afs_account_mappings/i.test((args[0] as readonly string[]).join(' ')),
  );
}

describe('getMappedTrialBalance — balances from source-of-truth journal lines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('derives the current-period balance from posted journal lines, not the gl_account_balances cache', async () => {
    sqlMock
      .mockResolvedValueOnce([makeStatementLineRow('REV')]) // getStatementLines
      .mockResolvedValueOnce([                               // current-period balances
        { afs_line_code: 'REV', gl_account_id: 'gl-1', account_code: '4000', account_name: 'Sales', balance: '1000' },
      ]);

    const result = await getMappedTrialBalance(COMPANY_A, FISCAL_PERIOD);

    const balanceQueries = balanceQueriesOf(sqlMock.mock.calls);
    expect(balanceQueries.length, 'expected exactly the current-period balance query').toBe(1);

    const text = (balanceQueries[0]![0] as readonly string[]).join(' ');
    // Reads source-of-truth journal lines, NOT the drift-prone cache.
    expect(text).toMatch(/gl_journal_lines/i);
    expect(text).not.toMatch(/gl_account_balances/i);
    // Only posted lines contribute.
    expect(text).toMatch(/'posted'/);
    // Scoped to company + the requested fiscal period.
    expect(balanceQueries[0]!.slice(1)).toContain(COMPANY_A);
    expect(balanceQueries[0]!.slice(1)).toContain(FISCAL_PERIOD);

    // Result shape preserved.
    expect(result.find((l) => l.code === 'REV')?.currentAmount).toBe(1000);
  });

  it('derives the prior-period balance from journal lines too, scoped to the prior period', async () => {
    sqlMock
      .mockResolvedValueOnce([makeStatementLineRow('REV')]) // getStatementLines
      .mockResolvedValueOnce([                               // current period
        { afs_line_code: 'REV', gl_account_id: 'gl-1', account_code: '4000', account_name: 'Sales', balance: '1000' },
      ])
      .mockResolvedValueOnce([                               // prior period
        { gl_account_id: 'gl-1', balance: '800' },
      ]);

    const result = await getMappedTrialBalance(COMPANY_A, FISCAL_PERIOD, PRIOR_PERIOD);

    const balanceQueries = balanceQueriesOf(sqlMock.mock.calls);
    expect(balanceQueries.length, 'expected current + prior balance queries').toBe(2);

    for (const q of balanceQueries) {
      const text = (q[0] as readonly string[]).join(' ');
      expect(text).toMatch(/gl_journal_lines/i);
      expect(text).not.toMatch(/gl_account_balances/i);
    }

    // The prior-period query must carry the prior fiscal period id.
    const priorQuery = balanceQueries[1]!;
    expect(priorQuery.slice(1)).toContain(PRIOR_PERIOD);

    expect(result.find((l) => l.code === 'REV')?.priorAmount).toBe(800);
  });
});
