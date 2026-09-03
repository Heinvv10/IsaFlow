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

vi.mock('@/modules/accounting/services/reports/budgetVarianceService', () => ({
  getBudgetVariance: vi.fn(),
}));

import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
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
  unbudgeted_accounts: number;
  unbudgeted_movement: number;
}

function json(res: { content: Array<{ text: string }>; isError?: boolean }): Env {
  expect(res.isError).toBeUndefined();
  return JSON.parse(res.content[0]!.text) as Env;
}

function line(code: string, budget: number, actual: number) {
  return {
    account_id: `id-${code}`,
    account_code: code,
    account_name: `Account ${code}`,
    account_type: 'expense',
    budget_amount: budget,
    actual_amount: actual,
    variance: budget - actual,
    variance_pct: budget > 0 ? ((budget - actual) / budget) * 100 : 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBudgetVariance).mockResolvedValue({
    fiscalYear: 2026,
    monthKeys: ['mar', 'apr', 'may'],
    rows: [line('6000', 30000, 25000)],
    unbudgeted: [line('49784360', 0, 7734785.71)],
    universeTotal: 2,
    totals: { budget: 30000, actual: 25000, variance: 5000 },
    unbudgetedMovement: 7734785.71,
    postedThrough: '2026-05-29',
  });
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
    expect(vi.mocked(getBudgetVariance).mock.calls[0]![0]).toBe(COMPANY);
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
    vi.mocked(getBudgetVariance).mockResolvedValue({
      fiscalYear: 2026,
      monthKeys: ['mar'],
      rows: [],
      unbudgeted: [line('49784360', 0, 7734785.71), line('49784353', 0, 2327887.5)],
      universeTotal: 2,
      totals: { budget: 0, actual: 0, variance: 0 },
      unbudgetedMovement: 10062673.21,
      postedThrough: '2026-03-31',
    });
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
    expect(env.months_covered).toEqual(['mar', 'apr', 'may']);
    expect(env.figureBasis).toBe('budget.actual.v1');
    expect(env.posted_through).toBe('2026-05-29T00:00:00.000Z');
  });

  it('serves totals but no rows at detail: summary', async () => {
    const env = json(await budgetVarianceTool.handler(
      { period_start: '2026-03-01', period_end: '2026-05-31', detail: 'summary' }, ctx,
    ));
    expect(env.rows).toHaveLength(0);
    expect(env.rowsTotal).toBe(1);
    expect(env.totals.budget).toBe(30000);
    expect(env.completenessFault).toBeUndefined();
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
