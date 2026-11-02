/**
 * budget_variance's version and dimension arguments (budgets P3 PR-F): the contract a mocked engine
 * can prove. With none of them the default path runs exactly as before (the byte-identical output is
 * proved on real Postgres in tests/integration/budget-variance-mcp-default.int.test.ts); with any,
 * only the given ones reach the engine's filtered view, a bad id is refused before any read, an id
 * that is not this company's reads as any other miss, and the engine's verdicts are named
 * exclusions. The figures under a filter are proved in tests/integration/budget-variance-mcp-dims.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/tracking/trackingRange', () => ({ buildRangeTracking: vi.fn() }));

import { buildRangeTracking } from '@/modules/accounting/services/budgets/tracking/trackingRange';
import { TrackingError, type BudgetVerdict, type TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import * as varianceService from '@/modules/accounting/services/reports/budgetVarianceService';
import { budgetVarianceTool } from '@/lib/mcp/tools/budgetVariance';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '22222222-2222-2222-2222-222222222222';
const V = '44444444-4444-4444-4444-444444444444';
const CC = '55555555-5555-5555-5555-555555555555';
const BU = '66666666-6666-6666-6666-666666666666';
const ctx: McpToolContext = {
  userId: '33333333-3333-3333-3333-333333333333', companyId: COMPANY, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: null,
};
const RANGE = { period_start: '2026-03-01', period_end: '2026-05-31' };

const line = (code: string, verdict: BudgetVerdict, actual: number, budget: number | null): TrackingLine => ({
  accountId: `id-${code}`, accountCode: code, accountName: `Account ${code}`, accountType: 'expense', band: 'operating_expense',
  actual, budget, variance: budget === null ? null : actual - budget, variancePct: null, favourable: null,
  projected: actual, fyBudget: null, projVariance: null, projFavourable: null, unallocatedBudget: verdict === 'above-filter' ? 900 : 0,
  budgetAboveFilter: verdict === 'above-filter', fyBudgetAboveFilter: verdict === 'above-filter', partialBudget: verdict === 'partial',
  budgetVerdict: verdict, monthly: [],
});

function engine(lines: TrackingLine[]) {
  vi.mocked(buildRangeTracking).mockResolvedValue({
    startFiscalYear: 2026, months: ['2026-03', '2026-04', '2026-05'], years: [{ fiscalYear: 2026, months: [] }], lines, bands: [],
    budgetAbsent: false, splitsMonth: false,
    notices: { unbudgetedCount: 1, unbudgetedActual: { income: 0, expense: 40 }, unallocatedBudget: { income: 0, expense: 900 },
      noVersion: false, partialBudget: null, noVersionYears: [], noBudgetAtFilterYears: [] },
    version: { id: V, name: 'Reforecast 1', kind: 'reforecast', status: 'draft', isPrimary: false },
    filter: {}, postedThrough: '2026-05-29',
  } as never);
}

const getBudgetVariance = vi.spyOn(varianceService, 'getBudgetVariance');
const json = (res: { content: Array<{ text: string }>; isError?: boolean }) => {
  expect(res.isError).toBeUndefined();
  return JSON.parse(res.content[0]!.text) as Record<string, unknown> & { excludedRows: Array<{ id: string; reason: string; amount?: number }> };
};

beforeEach(() => {
  vi.clearAllMocks();
  engine([line('6000', 'budgeted', 100, 120), line('6100', 'above-filter', 30, null), line('6200', 'partial', 20, null), line('6300', 'unbudgeted', 40, null)]);
});

describe('budget_variance version and dimensions', () => {
  it('declares the four as optional uuids, nothing else new, still closed to unknown arguments', () => {
    const schema = budgetVarianceTool.inputSchema as { properties: Record<string, { format?: string }>; required: string[]; additionalProperties: boolean };
    for (const k of ['version_id', 'cc1_id', 'cc2_id', 'bu_id']) expect(schema.properties[k]?.format, k).toBe('uuid');
    expect(schema.required).toEqual(['period_start', 'period_end']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('with none of them, calls the service exactly as before (no options at all)', async () => {
    await budgetVarianceTool.handler(RANGE, ctx);
    expect(getBudgetVariance.mock.calls[0]).toEqual([COMPANY, '2026-03-01', '2026-05-31']);
  });

  it('passes only the arguments given to the filtered view, never defaulting an absent one', async () => {
    await budgetVarianceTool.handler({ ...RANGE, cc1_id: CC }, ctx);
    expect(getBudgetVariance.mock.calls[0]).toEqual([COMPANY, '2026-03-01', '2026-05-31', { partialWindow: 'absent', cc1Id: CC }]);
    await budgetVarianceTool.handler({ ...RANGE, version_id: V, bu_id: BU }, ctx);
    expect(getBudgetVariance.mock.calls[1]?.[3]).toEqual({ partialWindow: 'absent', versionId: V, buId: BU });
  });

  it.each(['version_id', 'cc1_id', 'cc2_id', 'bu_id'])('refuses a malformed %s before any read', async (k) => {
    const res = await budgetVarianceTool.handler({ ...RANGE, [k]: 'not-a-uuid' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(`invalid ${k}`);
    expect(getBudgetVariance).not.toHaveBeenCalled();
  });

  it('reads an id that is not this company\'s as any other miss, and passes a window refusal through', async () => {
    vi.mocked(buildRangeTracking).mockRejectedValueOnce(new TrackingError(404, `version ${V} is not found for company X`));
    const miss = await budgetVarianceTool.handler({ ...RANGE, version_id: V }, ctx);
    expect(miss).toEqual({ content: [{ type: 'text', text: 'Not found' }], isError: true });
    vi.mocked(buildRangeTracking).mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'version gone'));
    expect((await budgetVarianceTool.handler({ ...RANGE, version_id: V }, ctx)).content[0]!.text).toBe('Not found');
    vi.mocked(buildRangeTracking).mockRejectedValueOnce(new TrackingError(400, 'version is FY2027; the window reaches FY2028'));
    expect((await budgetVarianceTool.handler({ ...RANGE, version_id: V }, ctx)).content[0]!.text).toBe('version is FY2027; the window reaches FY2028');
  });

  it('rethrows anything that is not a refusal', async () => {
    vi.mocked(buildRangeTracking).mockRejectedValueOnce(new Error('connection lost'));
    await expect(budgetVarianceTool.handler({ ...RANGE, cc1_id: CC }, ctx)).rejects.toThrow('connection lost');
  });

  it('names every engine verdict that keeps a budget out of the rows, with its actual', async () => {
    const env = json(await budgetVarianceTool.handler({ ...RANGE, cc1_id: CC }, ctx));
    expect((env.rows as Array<{ account_code: string }>).map((r) => r.account_code)).toEqual(['6000']);
    expect(env.excludedRows.map((x) => [x.id, x.reason, x.amount])).toEqual([
      ['id-6100', 'budget_above_filter', 30], ['id-6200', 'budget_partial', 20], ['id-6300', 'no_budget_set', 40],
    ]);
    expect(env.completenessFault).toBeUndefined();
  });

  it('adds version, the filter, the unallocated budget (only with a dimension) and why a budget may be absent', async () => {
    const env = json(await budgetVarianceTool.handler({ ...RANGE, cc1_id: CC }, ctx));
    expect(env).toMatchObject({
      version: { id: V, name: 'Reforecast 1', kind: 'reforecast', status: 'draft', isPrimary: false },
      dimension_filter: { cc1_id: CC, cc2_id: null, bu_id: null },
      unallocated_budget: { income: 0, expense: 900 },
      budget_absent_years: [], budget_outside_filter_years: [], splits_budget_month: false,
      figureBasis: 'budget.actual.v1',
    });
    const byVersion = json(await budgetVarianceTool.handler({ ...RANGE, version_id: V }, ctx));
    expect(byVersion).not.toHaveProperty('unallocated_budget');
  });

  it('describes the version default, the explicit levels, and that a budget above the filter is never apportioned', () => {
    const d = budgetVarianceTool.description;
    expect(d).toMatch(/Without version_id each financial year is read on its primary budget version/);
    expect(d).toMatch(/EXPLICIT dimension level, ANDed/);
    expect(d).toMatch(/never split or apportioned/);
    expect(d).toMatch(/reason budget_above_filter/);
    expect(d).toMatch(/WHOLE MONTHS/);
  });
});
