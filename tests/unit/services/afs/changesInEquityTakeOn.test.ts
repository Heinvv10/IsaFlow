/**
 * PR #768 round 5, item 1: postings from a take-on (source 'auto_migration':
 * the wizard's and Import from Sage's opening balances and take-on documents,
 * the MCP set_opening_balance) are balances brought into IsaFlow, not
 * movements of the year. On Retained Earnings the SoCE read every in-year
 * posting as a DIVIDEND: a Sage take-on folding R38 000 of profit onto prior
 * Retained Income of -15 000 showed R23 000 of "dividends". They have their
 * own row now; real dividends are unchanged.
 */
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/trialBalanceBasis', () => ({ getRetainedEarningsBroughtForward: vi.fn(async () => 0) }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', () => ({ getFinancialFigures: vi.fn(async () => ({ period: { netProfit: 0 } })) }));

import { sql } from '@/lib/neon';
import { getChangesInEquity } from '@/modules/accounting/services/afs/changesInEquityService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;
const arrange = (movements: unknown[]) => { mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce(movements); };

beforeEach(() => vi.clearAllMocks());

describe('changes in equity: take-on postings', () => {
  it('a take-on on Retained Earnings is a balance taken on, not a dividend', async () => {
    arrange([{ account_subtype: 'retained_earnings', is_take_on: true, amount: 23000 }]);
    const r = await getChangesInEquity('co', '2026-01-01', '2026-12-31');
    const re = r.columns.find((c) => c.subtype === 'retained_earnings')!;
    expect(re.dividends).toBe(0);
    expect(re.takeOn).toBeCloseTo(23000, 2);
    expect(re.closing).toBeCloseTo(23000, 2);
    expect(r.totalDividends).toBe(0);
    expect(r.totalTakeOn).toBeCloseTo(23000, 2);
  });

  it('a take-on on share capital or Opening Balance Equity is a take-on too, not a share issue or other movement', async () => {
    arrange([
      { account_subtype: 'share_capital', is_take_on: true, amount: 9000 },
      { account_subtype: 'opening_balance_equity', is_take_on: true, amount: -2000 },
    ]);
    const r = await getChangesInEquity('co', '2026-01-01', '2026-12-31');
    const sc = r.columns.find((c) => c.subtype === 'share_capital')!;
    expect([sc.shareIssue, sc.takeOn]).toEqual([0, 9000]);
    expect(r.totalOtherMovements).toBe(0);
    expect(r.totalTakeOn).toBeCloseTo(7000, 2);
  });

  it('a real dividend on Retained Earnings, beside a take-on, is still a dividend', async () => {
    arrange([
      { account_subtype: 'retained_earnings', is_take_on: true, amount: 23000 },
      { account_subtype: 'retained_earnings', is_take_on: false, amount: -5000 },
    ]);
    const re = (await getChangesInEquity('co', '2026-01-01', '2026-12-31')).columns.find((c) => c.subtype === 'retained_earnings')!;
    expect(re.dividends).toBeCloseTo(-5000, 2);
    expect(re.takeOn).toBeCloseTo(23000, 2);
    expect(re.closing).toBeCloseTo(18000, 2);
  });

  it('the movements query tells take-on journals apart by their source', async () => {
    arrange([]);
    await getChangesInEquity('co', '2026-01-01', '2026-12-31');
    const text = (mockSql.mock.calls[1]![0] as unknown as string[]).join('?');
    expect(text).toMatch(/je\.source = \? AS is_take_on/);
    expect(mockSql.mock.calls[1]).toContain('auto_migration');
  });
});
