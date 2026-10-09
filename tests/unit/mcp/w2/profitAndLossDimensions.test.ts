/**
 * `profit_and_loss` — cost_centre_id / business_unit_id filters and group_by.
 *
 * THE FILTER BUG. cost_centre_id was accepted, validated and echoed back, and
 * then reached only the classification coverage: every band came from
 * getFinancialFigures, which has no dimension predicate, so a "Fibertime" P&L
 * was the whole company's. A filtered call must fold the filtered lines and must
 * not consult the unfiltered figures at all.
 *
 * GROUP_BY. One column per member plus untagged; `by_dimension.residual` is the
 * ungrouped figures printed on the same response (from getFinancialFigures, a
 * different query) minus the columns. Zero means the columns tie; a non-zero is
 * reported, never absorbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', () => ({ getFinancialFigures: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/classificationCoverageService', () => ({
  getClassificationCoverage: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-08-31T22:15:00.000Z'),
}));

import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import { getClassificationCoverage } from '@/modules/accounting/services/reports/classificationCoverageService';
import { aggregateFigures } from '@/modules/accounting/services/gl/accountClassification';
import { profitAndLossTool } from '@/lib/mcp/tools/reportsProfitAndLoss';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;
const FT = 'aaaaaaaa-0000-4000-8000-000000000001';
const CIV = 'bbbbbbbb-0000-4000-8000-000000000001';

const payload = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

const dimRow = (
  code: string, type: 'revenue' | 'expense', subtype: string | null,
  member: string | null, debit: number, credit: number,
) => ({
  account_id: `acc-${code}`, account_code: code, account_name: code, account_type: type,
  account_subtype: subtype, member_id: member, total_debit: debit, total_credit: credit, line_count: 1,
});

/** BU-grouped movement for the month: Civils, plus untagged. */
const ROWS = [
  dimRow('4000', 'revenue', null, CIV, 0, 600_000.55),
  dimRow('4000', 'revenue', null, null, 0, 400_000),
  dimRow('5000', 'expense', 'cost_of_sales', CIV, 350_000.45, 0),
  dimRow('6000', 'expense', null, null, 120_000, 0),
  dimRow('5810', 'expense', 'finance_cost', null, 15_000, 0),
];

/** The same movement folded the way getFinancialFigures does (type × subtype). */
const WHOLE = aggregateFigures([
  { account_type: 'revenue', account_subtype: null, debit: 0, credit: 1_000_000.55 },
  { account_type: 'expense', account_subtype: 'cost_of_sales', debit: 350_000.45, credit: 0 },
  { account_type: 'expense', account_subtype: null, debit: 120_000, credit: 0 },
  { account_type: 'expense', account_subtype: 'finance_cost', debit: 15_000, credit: 0 },
]);

const EMPTY_SIDE = {
  totalAmount: 0, classifiedAmount: 0, unclassifiedAmount: 0,
  unclassifiedAccountCount: 0, accounts: [], truncated: false,
};

function routeSql(rows: unknown[]) {
  sqlMock.mockImplementation((strings: TemplateStringsArray | undefined) => {
    const text = Array.isArray(strings) ? strings.join('$') : '';
    if (text.includes('AS member_id')) return Promise.resolve(rows);
    if (text.includes('FROM business_units bu')) {
      return Promise.resolve([{ id: CIV, code: 'CIV', name: 'Civils', parent_code: null }]);
    }
    return Promise.resolve([]);
  });
}

const call = (args: Record<string, unknown>) =>
  profitAndLossTool.handler({ period_start: '2026-04-01', period_end: '2026-04-30', ...args }, CTX);

beforeEach(() => {
  sqlMock.mockReset();
  vi.mocked(getFinancialFigures).mockReset().mockResolvedValue({ period: WHOLE } as never);
  vi.mocked(getClassificationCoverage).mockReset()
    .mockResolvedValue({ revenue: EMPTY_SIDE, expense: EMPTY_SIDE } as never);
});

describe('profit_and_loss cost_centre_id / business_unit_id restrict the figures', () => {
  it('a cost-centre filter folds only the filtered lines and never reads the whole-company figures', async () => {
    // What the filtered query returns: Fibertime's lines only.
    routeSql([
      dimRow('4000', 'revenue', null, null, 0, 250_000),
      dimRow('5000', 'expense', 'cost_of_sales', null, 100_000, 0),
    ]);
    const body = payload(await call({ cost_centre_id: FT }));
    expect(getFinancialFigures).not.toHaveBeenCalled();
    expect(body.turnover).toBe(250_000);
    expect(body.costOfSales).toBe(100_000);
    expect(body.netProfit).toBe(150_000);
    expect(body.cost_centre_id).toBe(FT);

    const [strings, ...values] = sqlMock.mock.calls[0]! as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('$')).toMatch(/jl\.cc1_id = \$::UUID OR jl\.cc2_id = \$::UUID/);
    expect(values).toContain(FT);
    // The coverage qualifies the same filtered statement.
    expect(getClassificationCoverage).toHaveBeenCalledWith(CTX.companyId, '2026-04-01', '2026-04-30', FT, undefined);
  });

  it('the comparative is filtered too', async () => {
    routeSql([dimRow('4000', 'revenue', null, null, 0, 10)]);
    const body = payload(await call({ business_unit_id: CIV, compare: 'prior_period' }));
    expect(getFinancialFigures).not.toHaveBeenCalled();
    expect((body.comparative as Record<string, unknown>).turnover).toBe(10);
    expect(body.business_unit_id).toBe(CIV);
  });

  it('rejects a non-uuid business_unit_id before any query', async () => {
    const r = await call({ business_unit_id: 'civils' });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('profit_and_loss group_by — columns tie to the ungrouped P&L', () => {
  it('returns one column per member plus untagged, and a zero residual against getFinancialFigures', async () => {
    routeSql(ROWS);
    const body = payload(await call({ group_by: 'bu' }));
    const dim = body.by_dimension as {
      group_by: string; ties: boolean; residual: Record<string, number>;
      columns: Array<Record<string, unknown>>;
    };
    expect(dim.group_by).toBe('bu');
    expect(dim.columns.map((c) => c.code)).toEqual(['CIV', 'UNTAGGED']);
    expect(dim.ties).toBe(true);
    expect(Object.values(dim.residual).every((v) => v === 0)).toBe(true);

    const [civ, untagged] = dim.columns as Array<Record<string, number | null>>;
    expect(civ!.turnover).toBe(600_000.55);
    expect(civ!.grossProfit).toBe(250_000.1);
    expect(untagged!.member_id).toBeNull();
    expect(untagged!.netProfit).toBe(265_000);
    expect(body.netProfit).toBe(Math.round((civ!.netProfit! + untagged!.netProfit!) * 100) / 100);
  });

  it('a mismatch with the ungrouped figures is reported, not absorbed', async () => {
    routeSql(ROWS);
    vi.mocked(getFinancialFigures).mockResolvedValue({
      period: { ...WHOLE, revenue: WHOLE.revenue + 5, grossProfit: WHOLE.grossProfit + 5,
        operatingProfit: WHOLE.operatingProfit + 5, netProfit: WHOLE.netProfit + 5 },
    } as never);
    const dim = payload(await call({ group_by: 'cc2' })).by_dimension as {
      ties: boolean; residual: Record<string, number>;
    };
    expect(dim.ties).toBe(false);
    expect(dim.residual.turnover).toBe(5);
    expect(dim.residual.netProfit).toBe(5);
    expect(dim.residual.costOfSales).toBe(0);
  });

  it('rejects an unknown group_by', async () => {
    const r = await call({ group_by: 'project' });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it('omits by_dimension when group_by is absent', async () => {
    routeSql(ROWS);
    expect(payload(await call({})).by_dimension).toBeUndefined();
  });
});
