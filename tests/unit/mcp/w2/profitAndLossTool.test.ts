/**
 * `profit_and_loss` v2 (W2) — a WRAP of the OWNED classifier.
 *
 * It consumes `gl/financialFiguresService#getFinancialFigures`, which folds
 * through `gl/accountClassification#aggregateFigures` — the implementation AFS
 * already uses — rather than `reports/incomeStatementService`, which rolls its
 * own two-way split. That is a deliberate, recorded, temporary divergence:
 * the two agree on the BOTTOM LINE to the cent on both production companies and
 * differ only in which band a figure sits in. `getIncomeStatement` keeps the
 * page, `reports-management-accounts` and AFS until the convergence PR.
 *
 * THE COVERAGE EXCEPTION IS THE POINT OF THIS TOOL, not an addition to it.
 * Velocity's gross profit is revenue less 2.4% of its costs, with 100% of its
 * revenue and 97.6% of its expenses on accounts nobody has classified. So the
 * coverage is present at EVERY detail level including summary, it cannot be
 * suppressed, and nothing is excluded from any total.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', () => ({
  getFinancialFigures: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/classificationCoverageService', () => ({
  getClassificationCoverage: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/postedThroughService', () => ({
  getLedgerPostedThrough: vi.fn().mockResolvedValue('2026-08-31T22:15:00.000Z'),
}));

import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import { getClassificationCoverage } from '@/modules/accounting/services/reports/classificationCoverageService';
import { profitAndLossTool } from '@/lib/mcp/tools/reportsProfitAndLoss';
import { assertEnvelopeSound, getFigureDefinition } from '@/lib/mcp/contracts';
import type { McpToolContext } from '@/lib/mcp/types';

const CTX = {
  userId: 'u1', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a',
} as McpToolContext;

const payload = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

/** Turnover 1000, other income 50, COS 400, opex 300, finance+tax 100. */
const FIGURES = {
  revenue: 1000, otherIncome: 50, costOfSales: 400, grossProfit: 600,
  operatingExpenses: 300, otherExpenses: 100, depreciation: 25,
  // Other income is ABOVE the operating line: 600 + 50 - 300. The tool reads
  // this field rather than recomputing it, so the fixture must carry it.
  operatingProfit: 350,
  netProfit: 250,
  unclassifiedCount: 0, unclassifiedTotal: 0,
  unclassifiedByType: {
    asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
    equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
    expense: { accounts: 0, amount: 0 },
  },
};

const COVERAGE = {
  revenue: {
    totalAmount: 1050, classifiedAmount: 1050, unclassifiedAmount: 0,
    unclassifiedAccountCount: 0, accounts: [], truncated: false,
  },
  expense: {
    totalAmount: 800, classifiedAmount: 800, unclassifiedAmount: 0,
    unclassifiedAccountCount: 0, accounts: [], truncated: false,
  },
};

beforeEach(() => {
  vi.mocked(getFinancialFigures).mockReset().mockResolvedValue({ period: FIGURES } as never);
  vi.mocked(getClassificationCoverage).mockReset().mockResolvedValue(COVERAGE as never);
});

describe('profit_and_loss', () => {
  it('reports the LAYER: turnover, other income, finance/tax, and three profit lines', async () => {
    const body = payload(await profitAndLossTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31' }, CTX,
    ));
    assertEnvelopeSound(body as never);

    expect(body.turnover).toBe(1000);
    expect(body.otherIncome).toBe(50);
    expect(body.costOfSales).toBe(400);
    expect(body.grossProfit).toBe(600);
    expect(body.operatingExpenses).toBe(300);
    expect(body.otherExpenses).toBe(100);
    // Operating profit excludes finance cost and tax and includes other income.
    // Since the B75 convergence getIncomeStatement computes it the same way.
    expect(body.operatingProfit).toBe(350);
    expect(body.netProfit).toBe(250);
  });

  it('keeps other income OUT of gross profit', async () => {
    // Other income is revenue-typed, so a two-way split counts it as turnover
    // and it reaches gross profit. It is not trading revenue and must not.
    const body = payload(await profitAndLossTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31' }, CTX,
    ));
    expect(body.grossProfit).toBe(1000 - 400);
    expect(body.grossProfit).not.toBe(1000 + 50 - 400);
  });

  it('serves the coverage at EVERY detail level, summary included', async () => {
    for (const detail of ['summary', 'standard', 'full']) {
      const body = payload(await profitAndLossTool.handler(
        { period_start: '2026-03-01', period_end: '2026-03-31', detail }, CTX,
      ));
      // Not suppressible. The coverage is the finding, not a verbosity level.
      expect(body.classificationCoverage).toBeDefined();
    }
  });

  it('names the unclassified accounts and reports the share, excluding nothing', async () => {
    vi.mocked(getClassificationCoverage).mockResolvedValue({
      revenue: {
        totalAmount: 84053370.26, classifiedAmount: 0, unclassifiedAmount: 84053370.26,
        unclassifiedAccountCount: 4,
        accounts: [{
          accountId: 'aaaaaaaa-0000-4000-8000-000000000001', accountCode: '4000',
          accountName: 'Sales', accountSubtype: null, amount: 84053370.26,
        }],
        truncated: false,
      },
      expense: {
        totalAmount: 118869595.15, classifiedAmount: 2885070.10,
        unclassifiedAmount: 115984525.05, unclassifiedAccountCount: 37,
        accounts: [], truncated: false,
      },
    } as never);

    const body = payload(await profitAndLossTool.handler(
      { period_start: '2020-01-01', period_end: '2026-12-31' }, CTX,
    ));
    const cov = body.classificationCoverage as {
      revenue: { unclassifiedShare: number; accounts: unknown[] };
      expense: { unclassifiedShare: number };
      reliable: boolean;
    };
    // 100% and 97.6% — the Velocity shape.
    expect(cov.revenue.unclassifiedShare).toBe(1);
    expect(cov.expense.unclassifiedShare).toBeCloseTo(0.9757, 3);
    expect(cov.revenue.accounts).toHaveLength(1);
    expect(cov.reliable).toBe(false);
    // Nothing is netted out of the statement itself.
    expect(body.turnover).toBe(1000);
  });

  it('computes the comparative on the CALENDAR when asked for prior_period', async () => {
    await profitAndLossTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31', compare: 'prior_period' }, CTX,
    );
    // February, not 29 January – 28 February. The page's millisecond
    // arithmetic produced the latter and February never appeared as itself.
    expect(vi.mocked(getFinancialFigures).mock.calls[1]).toEqual([
      CTX.companyId, '2026-02-01', '2026-02-28',
    ]);
  });

  it('computes prior_year, and accepts explicit compare dates', async () => {
    await profitAndLossTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31', compare: 'prior_year' }, CTX,
    );
    expect(vi.mocked(getFinancialFigures).mock.calls[1]).toEqual([
      CTX.companyId, '2025-03-01', '2025-03-31',
    ]);

    vi.mocked(getFinancialFigures).mockClear();
    await profitAndLossTool.handler(
      {
        period_start: '2026-03-01', period_end: '2026-03-31',
        compare_start: '2025-01-01', compare_end: '2025-01-31',
      },
      CTX,
    );
    expect(vi.mocked(getFinancialFigures).mock.calls[1]).toEqual([
      CTX.companyId, '2025-01-01', '2025-01-31',
    ]);
  });

  it('reports the comparative figures and the variance on the bottom line', async () => {
    vi.mocked(getFinancialFigures)
      .mockResolvedValueOnce({ period: FIGURES } as never)
      .mockResolvedValueOnce({ period: { ...FIGURES, netProfit: 100, revenue: 800 } } as never);
    const body = payload(await profitAndLossTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31', compare: 'prior_period' }, CTX,
    ));
    expect(body.comparative).toMatchObject({
      period_start: '2026-02-01', period_end: '2026-02-28',
      turnover: 800, netProfit: 100,
    });
    expect(body.netProfitVariance).toBe(150);
  });

  it('tells a reader the page and this tool AGREE, and does not describe a divergence that is fixed', async () => {
    const d = profitAndLossTool.description;
    expect(d).toContain('aggregateFigures');
    expect(d).toContain('getIncomeStatement');
    // This used to assert the OPPOSITE — that the description named a
    // presentational divergence and warned the bottom lines merely tie. B75
    // fixed the divergence, and a shipped tool description is runtime guidance
    // to an agent: leaving the old text would have an assistant "correct"
    // figures that now agree, or tell a user the page overstates gross profit
    // when it does not.
    expect(d).toContain('AGREE band for band');
    expect(d).not.toContain('BOTTOM LINE to the cent');
    expect(d).not.toContain('counts other income as turnover');
    // The one real remaining difference is scope, not banding.
    expect(d).toMatch(/project or cost-centre filter/i);
  });

  it('names the three new figure ids, all owned by the classifier', async () => {
    for (const id of ['otherincome.period.v1', 'financecost.period.v1', 'tax.period.v1']) {
      expect(getFigureDefinition(id)!.owner).toBe('gl/accountClassification#aggregateFigures');
    }
    const body = payload(await profitAndLossTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31' }, CTX,
    ));
    expect(body.figureBases).toMatchObject({
      otherIncome: 'otherincome.period.v1',
      otherExpenses: 'financecost.period.v1',
    });
  });

  it('refuses dates Postgres could not cast, and a compare window that is not earlier', async () => {
    for (const args of [
      { period_start: '2026-02-31', period_end: '2026-03-31' },
      { period_start: '2026-03-01', period_end: '2026-03-31', compare_start: 'lol', compare_end: '2026-01-31' },
      { period_start: '2026-03-01', period_end: '2026-03-31', compare_start: '2026-03-05', compare_end: '2026-04-01' },
    ]) {
      expect(((await profitAndLossTool.handler(args, CTX)) as { isError?: boolean }).isError).toBe(true);
    }
    expect(vi.mocked(getFinancialFigures)).not.toHaveBeenCalled();
  });

  it('derives universeTotal from the coverage COUNT, not from the rows it served', async () => {
    // The list of named accounts is capped at 50. rowsTotal must be the
    // service's own complete count, so `truncated` means what it says and the
    // cap is reported as truncation rather than dressed up as an exclusion.
    // Computing excludedTotal as `universeTotal - rowsTotal` is the anti-pattern
    // CONTRACTS.md §1 names: it passes unconditionally, having proved nothing.
    vi.mocked(getClassificationCoverage).mockResolvedValue({
      revenue: {
        totalAmount: 100, classifiedAmount: 0, unclassifiedAmount: 100,
        unclassifiedAccountCount: 300,
        accounts: [{ accountId: 'a', accountCode: '4000', accountName: 'Sales', accountSubtype: null, amount: 100 }],
        truncated: true,
      },
      expense: {
        totalAmount: 0, classifiedAmount: 0, unclassifiedAmount: 0,
        unclassifiedAccountCount: 0, accounts: [], truncated: false,
      },
    } as never);
    const body = payload(await profitAndLossTool.handler(
      { period_start: '2026-03-01', period_end: '2026-03-31' }, CTX,
    ));
    assertEnvelopeSound(body as never);
    expect(body.rowsTotal).toBe(300);
    expect(body.universeTotal).toBe(300);
    expect(body.rowsReturned).toBe(1);
    expect(body.truncated).toBe(true);
    expect(body).not.toHaveProperty('excludedTotal');
  });
});
