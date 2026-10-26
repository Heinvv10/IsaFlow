/**
 * budget_variance — the contract, not the arithmetic.
 *
 * The arithmetic is proved against a real ledger in
 * tests/unit/services/budgetVarianceDb.test.ts. What is asserted here is the
 * part a mocked service can actually prove: that the tool takes its company
 * from the context and never from arguments, that it refuses a malformed or
 * inverted range before touching SQL, and — the point of the tool — that an
 * account with movement and no budget leaves as a NAMED EXCLUSION carrying its
 * value, rather than vanishing into an empty row list that reads as "on plan".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The DATA loaders are mocked; the service, the line builder and the sections
// are real, so the budgeted/unbudgeted split (D5) and totals = net profit (D11)
// are proved through the tool rather than restated in a fixture.
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/budgetWindowActuals', () => ({ loadWindowActuals: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/budgetWindowService', () => ({ loadWindowBudgets: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({
  fiscalYearForDate: vi.fn(async () => ({ fiscalYear: 2026 })),
}));

import { sql } from '@/lib/neon';
import { loadWindowActuals } from '@/modules/accounting/services/reports/budgetWindowActuals';
import { loadWindowBudgets } from '@/modules/accounting/services/reports/budgetWindowService';
import * as varianceService from '@/modules/accounting/services/reports/budgetVarianceService';
import { budgetVarianceTool } from '@/lib/mcp/tools/budgetVariance';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import { CLIENT_MCP_TOOL_NAMES } from '@/lib/mcp/clientMetadata';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const OTHER = '99999999-9999-9999-9999-999999999999';

const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333',
  companyId: COMPANY,
  scopes: ['read:reports'],
  tokenJti: 'j',
  oauthAppId: null,
};

interface Env {
  rows: Array<Record<string, unknown>>;
  rowsTotal: number;
  rowsReturned: number;
  excludedRows: Array<{ id: string; reason: string; amount?: number }>;
  completenessFault?: string;
  truncatedExcludedRows?: boolean;
  figureBasis?: string;
  posted_through: string;
  fiscal_year: number;
  months_covered: string[];
  totals: { budget: number; actual: number; variance: number };
  sections: Record<'revenue' | 'expense' | 'net_profit', { budget: number; actual: number; variance: number; movement: number }>;
  unbudgeted_accounts: number;
  unbudgeted_movement: number;
}

function json(res: { content: Array<{ text: string }>; isError?: boolean }): Env {
  expect(res.isError).toBeUndefined();
  return JSON.parse(res.content[0]!.text) as Env;
}

type Raw = { code: string; type: 'revenue' | 'expense'; actual: number };

/** Ledger and budgets the real service reads. */
function ledger(raws: Raw[], budgets: Record<string, number>, postedThrough = '2026-05-29') {
  vi.mocked(loadWindowActuals).mockResolvedValue(raws.map((r) => ({
    id: `id-${r.code}`, account_code: r.code, account_name: `Account ${r.code}`, account_type: r.type, actual_amount: r.actual,
  })));
  // Budgets are keyed by account id (budgetWindowService); the fixture writes codes for readability.
  vi.mocked(loadWindowBudgets).mockResolvedValue(Object.fromEntries(Object.entries(budgets).map(([c, v]) => [`id-${c}`, v])));
  vi.mocked(sql).mockResolvedValue([{ posted_through: postedThrough }] as never);
}

const getBudgetVariance = vi.spyOn(varianceService, 'getBudgetVariance');

beforeEach(() => {
  vi.clearAllMocks();
  ledger([{ code: '6000', type: 'expense', actual: 25000 }, { code: '49784360', type: 'expense', actual: 7734785.71 }], { '6000': 30000 });
});

describe('budget_variance', () => {
  it('is registered, mirrored to clients and read-only', () => {
    expect(MCP_TOOLS.map(t => t.name)).toContain('budget_variance');
    expect(CLIENT_MCP_TOOL_NAMES).toContain('budget_variance');
    expect(budgetVarianceTool.write).toBe(false);
    expect(budgetVarianceTool.scope).toBe('read:reports');
  });

  it('takes the company from the context, never from args', async () => {
    await budgetVarianceTool.handler(
      { period_start: '2026-03-01', period_end: '2026-05-31', company_id: OTHER },
      ctx,
    );
    expect(getBudgetVariance.mock.calls[0]![0]).toBe(COMPANY);
  });

  it('names unbudgeted spend as an exclusion carrying its amount', async () => {
    const env = json(await budgetVarianceTool.handler(
      { period_start: '2026-03-01', period_end: '2026-05-31' }, ctx,
    ));
    expect(env.rows).toHaveLength(1);
    expect(env.excludedRows).toHaveLength(1);
    expect(env.excludedRows[0]!.reason).toBe('no_budget_set');
    expect(env.excludedRows[0]!.amount).toBeCloseTo(7734785.71, 2);
    expect(env.unbudgeted_movement).toBeCloseTo(7734785.71, 2);
    // rowsTotal + excluded === universe, so completeness is arithmetic.
    expect(env.completenessFault).toBeUndefined();
  });

  it('an unbudgeted company returns no rows AND says so in the exclusion total', async () => {
    ledger([{ code: '49784360', type: 'expense', actual: 7734785.71 }, { code: '49784353', type: 'expense', actual: 2327887.5 }], {}, '2026-03-31');
    const env = json(await budgetVarianceTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31' }, ctx,
    ));
    expect(env.rows).toHaveLength(0);
    expect(env.unbudgeted_accounts).toBe(2);
    expect(env.unbudgeted_movement).toBeCloseTo(10062673.21, 2);
    expect(env.completenessFault).toBeUndefined();
  });

  it('reports the fiscal year and months it matched, so the lookup is re-derivable', async () => {
    const env = json(await budgetVarianceTool.handler(
      { period_start: '2026-03-01', period_end: '2026-05-31' }, ctx,
    ));
    expect(env.fiscal_year).toBe(2026);
    expect(env.months_covered).toEqual(['2026-03', '2026-04', '2026-05']);
    expect(env.figureBasis).toBe('budget.actual.v1');
    expect(env.posted_through).toBe('2026-05-29T00:00:00.000Z');
  });

  it('serves totals but no rows at detail: summary', async () => {
    const env = json(await budgetVarianceTool.handler(
      { period_start: '2026-03-01', period_end: '2026-05-31', detail: 'summary' }, ctx,
    ));
    expect(env.rows).toHaveLength(0);
    expect(env.rowsTotal).toBe(1);
    // totals are net profit: an expense-only budget is a planned loss.
    expect(env.totals.budget).toBe(-30000);
    expect(env.completenessFault).toBeUndefined();
  });

  it('a zero budget is a row, not an exclusion', async () => {
    ledger([{ code: '6000', type: 'expense', actual: 25000 }, { code: '6100', type: 'expense', actual: 1200 }], { '6000': 30000, '6100': 0 });
    const env = json(await budgetVarianceTool.handler({ period_start: '2026-03-01', period_end: '2026-05-31' }, ctx));
    expect(env.rows.map((r) => r.account_code)).toEqual(['6000', '6100']);
    expect(env.excludedRows).toHaveLength(0);
    const zero = env.rows[1]!;
    expect(zero).toMatchObject({ budgeted: true, budget_amount: 0, variance: -1200, movement: 1200, variance_pct: null, favourable: false });
  });

  it('totals are net profit; sections carried; rows carry movement and favourable', async () => {
    ledger([
      { code: '4000', type: 'revenue', actual: 120000 },
      { code: '6000', type: 'expense', actual: 25000 },
      { code: '6200', type: 'expense', actual: 500 },
    ], { '4000': 100000, '6000': 30000 });
    const env = json(await budgetVarianceTool.handler({ period_start: '2026-03-01', period_end: '2026-05-31' }, ctx));
    // NP budget 100 000 − 30 000; actual 120 000 − 25 500; variance = Σ line variance (20 000 + 5 000 − 500).
    expect(env.totals).toEqual({ budget: 70000, actual: 94500, variance: 24500 });
    expect(env.sections.revenue).toMatchObject({ budget: 100000, actual: 120000, variance: 20000, movement: 20000 });
    expect(env.sections.expense).toMatchObject({ budget: 30000, actual: 25500, variance: 4500, movement: -4500 });
    expect(env.sections.net_profit).toMatchObject({ budget: 70000, actual: 94500, variance: 24500, movement: 24500 });
    const exp = env.rows.find((r) => r.account_code === '6000')!;
    expect(exp).toMatchObject({ variance: 5000, movement: -5000, favourable: true });
  });

  it('description says variance_pct is null where there is no budget, and what totals and movement are', () => {
    const d = budgetVarianceTool.description;
    expect(d).toMatch(/variance_pct is null where the budget is zero or absent/);
    expect(d).not.toMatch(/reported as 0 where there is no budget/);
    expect(d).toMatch(/totals are NET PROFIT/);
    expect(d).toMatch(/they do not foot to the rows/);
    expect(d).not.toMatch(/equal to the sum of the row and excluded-row variances/);
    expect(d).toMatch(/movement is actual less budget/);
    expect(d).toMatch(/A deliberate zero budget is a budget/);
  });

  it('refuses a malformed date before a cast', async () => {
    const res = await budgetVarianceTool.handler(
      { period_start: 'last March', period_end: '2026-05-31' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(getBudgetVariance).not.toHaveBeenCalled();
  });

  it('refuses an inverted range rather than silently returning nothing', async () => {
    const res = await budgetVarianceTool.handler(
      { period_start: '2026-05-31', period_end: '2026-03-01' }, ctx,
    );
    expect(res.isError).toBe(true);
    expect(getBudgetVariance).not.toHaveBeenCalled();
  });
});
