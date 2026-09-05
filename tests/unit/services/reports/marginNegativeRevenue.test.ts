/**
 * The four margin call sites, pinned at NEGATIVE revenue.
 *
 * Converging them onto one helper changed the guard from `revenue > 0` to
 * `revenue === 0` at two of them, so a period whose revenue total is negative
 * — credit notes or reversals exceeding sales, which the unguarded SQL sums
 * reach — began printing a computed margin where the pack and the KPI
 * dashboard had always printed 0. Nothing pinned it.
 *
 * Each expectation below is the value the call site produced BEFORE the
 * convergence, so this file fails if any of the four moves again.
 *
 * EXCEPT reportPackService, deliberately changed 2026-09-06: it now carries
 * marginPct2dp's `null` instead of coercing it to 0. "Gross margin 0.0%" on a
 * loss period is a figure nothing else on the pack supports, and the pack is
 * a document a director forwards to a bank. The surfaces print the reason
 * (packDocument.NO_MARGIN_REASON) in place of a percentage. The other three
 * call sites are unchanged and still pinned at 0 below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { buildReportPack, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';
import { getDashboardKPIs } from '@/modules/accounting/services/reports/kpiDashboardService';
import { calculateKpis, DEFAULT_RAG_THRESHOLDS, type FinancialSnapshot } from '@/modules/accounting/services/afs/afsKpiService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';

beforeEach(() => sqlMock.mockReset());

describe('reportPackService — null, so no percentage is printed at all', () => {
  const input = (revenue: number): ReportPackInput => ({
    companyName: 'Reversal Co', period: '2026-01-01 to 2026-01-31',
    revenue, costOfSales: 0, operatingExpenses: 50, otherIncome: 0, otherExpenses: 0,
    operatingProfit: revenue - 50, netProfit: revenue - 50,
    totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
    currentAssets: 0, currentLiabilities: 0, cash: 0,
    accountsReceivable: 0, accountsPayable: 0, inventory: 0,
    inventoryCaveat: null, classificationCaveat: null,
  });

  const margins = (revenue: number) => {
    const pack = buildReportPack('management', input(revenue), '2026-01-01', '2026-01-31');
    return pack.sections.find(s => s.type === 'income_statement')!.data as Record<string, number | null>;
  };

  it('emits no margin at all on negative revenue, neither 0 nor a computed percentage', () => {
    // Dividing a loss by negative turnover prints a healthy-looking POSITIVE
    // percentage, which is why `marginPct` refuses it. The old `?? 0` turned
    // that refusal back into a printable 0.0%.
    const m = margins(-100);
    expect(m.grossMargin).toBeNull();
    expect(m.netMargin).toBeNull();
  });

  it('emits no margin on zero revenue and a real figure on positive revenue', () => {
    expect(margins(0).grossMargin).toBeNull();
    expect(margins(200).grossMargin).toBeCloseTo(100, 10);
  });
});

describe('kpiDashboardService — 0, as it always was', () => {
  /** The service fires its queries in one Promise.all, in a fixed order:
   * revenue, prior revenue, expenses, … Only the first and third matter here. */
  const withTotals = (revenue: number, expenses: number) => {
    let call = 0;
    sqlMock.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve([{ total: revenue }]);
      if (call === 3) return Promise.resolve([{ total: expenses }]);
      return Promise.resolve([{}]);
    });
  };

  it('reports a 0 margin on negative revenue, not a computed one', async () => {
    withTotals(-100, 50);
    const kpis = await getDashboardKPIs('c-1', '2026-01-01', '2026-01-31');
    // The predecessor guard was `totalRevenue > 0 ? … : 0`. Gross profit here
    // is -150 over revenue of -100, which computes to a healthy-looking +150%.
    expect(kpis.grossProfit.amount).toBe(-150);
    expect(kpis.grossProfit.margin).toBe(0);
  });

  it('still computes on positive revenue', async () => {
    withTotals(200, 50);
    const kpis = await getDashboardKPIs('c-1', '2026-01-01', '2026-01-31');
    expect(kpis.grossProfit.margin).toBeCloseTo(75, 10);
  });
});

describe('afsKpiService — computes through a negative, as it always did', () => {
  const snapshot = (revenue: number): FinancialSnapshot => ({
    revenue, cogs: 0, grossProfit: -50, ebitda: -60, ebit: -60, netProfit: -70,
    currentAssets: 100, currentLiabilities: 50, inventory: 0,
    tradeReceivables: 0, tradePayables: 0, totalDebt: 0, totalEquity: 100,
    openingCash: 0, closingCash: 0, daysInPeriod: 31,
  });

  const value = (revenue: number, key: string) =>
    calculateKpis(snapshot(revenue), null, DEFAULT_RAG_THRESHOLDS).find(k => k.key === key)?.value;

  it('keeps its pre-existing behaviour: -50 over -100 is +50%', () => {
    // This service guarded `revenue === 0` and computed through a negative.
    // Converging it is a change to a live figure and belongs in its own change.
    expect(value(-100, 'grossMarginPct')).toBeCloseTo(50, 10);
    expect(value(-100, 'netProfitMarginPct')).toBeCloseTo(70, 10);
  });

  it('still reports 0 on zero revenue', () => {
    expect(value(0, 'grossMarginPct')).toBe(0);
  });
});

describe('incomeStatementService — computes through a negative, as it always did', () => {
  const glRow = (
    code: string, name: string, type: 'revenue' | 'expense',
    subtype: string | null, debit: number, credit: number,
  ) => ({
    account_code: code, account_name: name, account_type: type,
    account_subtype: subtype, total_debit: debit, total_credit: credit,
  });

  it('returns a computed margin, not null, when turnover is negative', async () => {
    // Reversals of 300 against sales of 200: turnover is -100.
    sqlMock.mockResolvedValue([
      glRow('4000', 'Sales', 'revenue', 'revenue', 300, 200),
      glRow('6000', 'Rent', 'expense', 'operating_expenses', 50, 0),
    ]);
    const r = await getIncomeStatement('c-1', '2026-01-01', '2026-01-31');
    expect(r.totalRevenue).toBeCloseTo(-100, 2);
    // Its guard has been `totalRevenue !== 0` since the field was added.
    expect(r.grossMarginPct).not.toBeNull();
    expect(r.grossMarginPct!).toBeCloseTo(100, 10);
  });

  it('is null on zero turnover', async () => {
    sqlMock.mockResolvedValue([glRow('6000', 'Rent', 'expense', 'operating_expenses', 50, 0)]);
    const r = await getIncomeStatement('c-1', '2026-01-01', '2026-01-31');
    expect(r.grossMarginPct).toBeNull();
  });
});
