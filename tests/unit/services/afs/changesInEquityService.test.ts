/**
 * Unit tests for changesInEquityService.ts
 *
 * The service now composes three sources: its own two equity queries, the
 * brought-forward accumulated result, and the income statement. The latter two
 * are mocked here so these tests stay about the composition; the reconciliation
 * to the balance sheet and income statement is proved against a real ledger in
 * tests/integration/afs-changes-in-equity.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/trialBalanceBasis', () => ({
  getRetainedEarningsBroughtForward: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', () => ({
  getFinancialFigures: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getRetainedEarningsBroughtForward } from '@/modules/accounting/services/gl/trialBalanceBasis';
import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;
const mockBroughtForward = getRetainedEarningsBroughtForward as unknown as MockedFunction<
  (...args: unknown[]) => Promise<number>
>;
const mockFigures = getFinancialFigures as unknown as MockedFunction<
  (...args: unknown[]) => Promise<unknown>
>;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const PERIOD_START = '2026-01-01';
const PERIOD_END   = '2026-12-31';

const OPENING_ROWS = [
  { account_subtype: 'share_capital',     balance: 100000 },
  { account_subtype: 'share_premium',     balance: 50000  },
  { account_subtype: 'retained_earnings', balance: 30000  },
  { account_subtype: 'revaluation',       balance: 5000   },
];

// Net movement per subtype — NOT split by posting sign. The retained-earnings
// figure is the net distribution: 8000 declared less 0 reversed.
const MOVEMENTS_ROWS = [
  { account_subtype: 'retained_earnings', amount: -8000 },
  { account_subtype: 'share_capital',     amount: 10000 },
  { account_subtype: 'share_premium',     amount: 40000 },
  { account_subtype: 'revaluation',       amount:  3000 },
];

const BROUGHT_FORWARD = 12000;
const PERIOD_NET_PROFIT = 20000;

function arrange(opening = OPENING_ROWS, movements = MOVEMENTS_ROWS): void {
  mockSql.mockResolvedValueOnce(opening).mockResolvedValueOnce(movements);
  mockBroughtForward.mockResolvedValueOnce(BROUGHT_FORWARD);
  mockFigures.mockResolvedValueOnce({ period: { netProfit: PERIOD_NET_PROFIT } });
}

describe('changesInEquityService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a matrix with correct opening balances', async () => {
    arrange();

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.periodStart).toBe(PERIOD_START);
    expect(result.periodEnd).toBe(PERIOD_END);

    const sc = result.columns.find(c => c.subtype === 'share_capital')!;
    expect(sc.opening).toBeCloseTo(100000, 2);
    expect(sc.shareIssue).toBeCloseTo(10000, 2);
    expect(sc.closing).toBeCloseTo(110000, 2);
  });

  it('opening retained earnings includes the accumulated result brought forward', async () => {
    arrange();

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    const re = result.columns.find(c => c.subtype === 'retained_earnings')!;
    // 30000 posted + 12000 earned before the period and never closed out.
    expect(re.opening).toBeCloseTo(42000, 2);
  });

  it('takes profit for the year from the income statement, not from equity postings', async () => {
    arrange();

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    const re = result.columns.find(c => c.subtype === 'retained_earnings')!;
    expect(re.profitForYear).toBeCloseTo(PERIOD_NET_PROFIT, 2);
    // The -8000 posting is a distribution, not negative profit.
    expect(re.dividends).toBeCloseTo(-8000, 2);
    expect(re.closing).toBeCloseTo(42000 + 20000 - 8000, 2);
  });

  it('routes an unrecognised reserve to other movements rather than dropping it', async () => {
    arrange(OPENING_ROWS, [
      ...MOVEMENTS_ROWS,
      { account_subtype: 'fc_translation_reserve', amount: 400 },
    ]);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    const fctr = result.columns.find(c => c.subtype === 'fc_translation_reserve')!;
    expect(fctr.otherMovements).toBeCloseTo(400, 2);
    expect(fctr.closing).toBeCloseTo(400, 2);
    expect(result.totalOtherMovements).toBeCloseTo(400, 2);
  });

  it('every column closes on opening plus its own movements', async () => {
    arrange();

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    for (const c of result.columns) {
      expect(c.closing).toBeCloseTo(
        c.opening + c.profitForYear + c.dividends + c.shareIssue + c.revaluation + c.otherMovements,
        2,
      );
    }
  });

  it('calculates the total equity column correctly', async () => {
    arrange();

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    // 185000 posted + 12000 brought forward.
    expect(result.totalOpening).toBeCloseTo(197000, 2);
    // plus 20000 profit, -8000 distributions, 50000 share issues, 3000 revaluation.
    expect(result.totalClosing).toBeCloseTo(262000, 2);
  });

  it('still reports a retained earnings column when no equity has ever been posted', async () => {
    // A company that has traded but never posted to an equity account still has
    // accumulated profit, and it has to appear somewhere.
    arrange([], []);

    const result = await getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END);

    expect(result.columns).toHaveLength(1);
    expect(result.columns[0]?.subtype).toBe('retained_earnings');
    expect(result.totalOpening).toBeCloseTo(BROUGHT_FORWARD, 2);
    expect(result.totalClosing).toBeCloseTo(BROUGHT_FORWARD + PERIOD_NET_PROFIT, 2);
  });

  it('logs error and re-throws on DB failure', async () => {
    const dbError = new Error('connection refused');
    mockSql.mockRejectedValueOnce(dbError);
    mockBroughtForward.mockResolvedValueOnce(0);
    mockFigures.mockResolvedValueOnce({ period: { netProfit: 0 } });

    await expect(
      getChangesInEquity(COMPANY_ID, PERIOD_START, PERIOD_END)
    ).rejects.toThrow('connection refused');
  });
});
