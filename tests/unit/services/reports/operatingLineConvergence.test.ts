/**
 * The operating line has ONE definition, and every surface uses it.
 *
 * `calculateFinancialRatios` and `calculateExtendedRatios` derived
 * `grossProfit - operatingExpenses` locally, excluding other income — a local
 * copy of the formula sitting beside the field introduced to abolish it. That
 * is live on eight endpoints (ratios, extended ratios, ratio trends, KPI
 * scorecard, executive summary, HTML pack, ai-commentary, reportPackDataService)
 * and on Brightsphere it computed operatingProfitMargin on R8,736,560.60 against
 * the authoritative R8,759,884.02 — the exact pair B75 records as the defect.
 * Nothing pinned it in either direction.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateFinancialRatios,
  calculateExtendedRatios,
  type FinancialData,
} from '@/modules/accounting/services/reports/reportingEngineService';
import { aggregateFigures } from '@/modules/accounting/services/gl/accountClassification';
import { toFinancialData } from '@/modules/accounting/services/gl/financialFiguresService';

const ROWS = [
  { account_type: 'revenue' as const, account_subtype: 'revenue', debit: 0, credit: 5000000 },
  { account_type: 'revenue' as const, account_subtype: 'other_income', debit: 0, credit: 53787.07 },
  { account_type: 'expense' as const, account_subtype: 'cost_of_sales', debit: 1800000, credit: 0 },
  { account_type: 'expense' as const, account_subtype: 'operating_expenses', debit: 400000, credit: 0 },
  { account_type: 'expense' as const, account_subtype: 'finance_cost', debit: 120000, credit: 0 },
];

const BASE: FinancialData = {
  revenue: 0, costOfSales: 0, operatingExpenses: 0, netProfit: 0,
  totalAssets: 1, totalLiabilities: 0, totalEquity: 1,
  currentAssets: 1, currentLiabilities: 1, inventory: 0,
  accountsReceivable: 0, accountsPayable: 0, cash: 0,
};

describe('the ratio engine uses the classifier operating line', () => {
  it('includes other income in operatingProfitMargin', () => {
    const f = aggregateFigures(ROWS);
    const data: FinancialData = {
      ...BASE,
      revenue: f.revenue, costOfSales: f.costOfSales,
      operatingExpenses: f.operatingExpenses, netProfit: f.netProfit,
      operatingProfit: f.operatingProfit, otherIncome: f.otherIncome,
    };
    const r = calculateFinancialRatios(data);
    // 5,000,000 - 1,800,000 + 53,787.07 - 400,000 = 2,853,787.07 on turnover.
    expect(r.operatingProfitMargin).toBeCloseTo((f.operatingProfit / f.revenue) * 100, 2);
    // The old local formula gives a different, lower number.
    const old = ((f.revenue - f.costOfSales - f.operatingExpenses) / f.revenue) * 100;
    expect(r.operatingProfitMargin).not.toBeCloseTo(old, 2);
  });

  it('computes EBIT on the same line', () => {
    const f = aggregateFigures(ROWS);
    const data: FinancialData = {
      ...BASE,
      revenue: f.revenue, costOfSales: f.costOfSales,
      operatingExpenses: f.operatingExpenses, netProfit: f.netProfit,
      operatingProfit: f.operatingProfit, otherIncome: f.otherIncome,
      depreciation: f.depreciation,
    };
    const e = calculateExtendedRatios(data);
    // EBIT = earnings before interest and tax, so other income is IN.
    expect(e.ebitda ?? 0).toBeCloseTo(f.operatingProfit + (f.depreciation ?? 0), 2);
  });

  it('falls back to the correct formula when a caller supplies no operatingProfit', () => {
    const f = aggregateFigures(ROWS);
    const r = calculateFinancialRatios({
      ...BASE,
      revenue: f.revenue, costOfSales: f.costOfSales,
      operatingExpenses: f.operatingExpenses, netProfit: f.netProfit,
      otherIncome: f.otherIncome,
    });
    expect(r.operatingProfitMargin).toBeCloseTo((f.operatingProfit / f.revenue) * 100, 2);
  });

  it('toFinancialData carries the classifier figure through', () => {
    const f = aggregateFigures(ROWS);
    const data = toFinancialData({ period: f, cumulative: f } as never);
    expect(data.operatingProfit).toBeCloseTo(f.operatingProfit, 2);
    expect(data.otherIncome).toBeCloseTo(f.otherIncome, 2);
  });
});
