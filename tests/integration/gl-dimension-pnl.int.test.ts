/**
 * P&L by dimension against a real database (PR #688 review round 1): the SQL
 * the unit suites could only mock — tenancy on every read, posted only, an
 * inclusive period end, the EFFECTIVE CC1 (cc1_id, else the legacy
 * cost_center_id) in every filter and in the cc1 grouping, the matrix honouring
 * the filter, the MCP business_unit_id, the coverage predicate, and the trial
 * balance / balance sheet using the same CC1.
 *
 * Every expected figure is worked by hand from the seed in
 * helpers/glDimensionFixture.ts (April 2025, company A). Disposable databases
 * only — the suite skips elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropGlDimensionFixture, seedGlDimensionFixture, type GlDimFixture } from './helpers/glDimensionFixture';
import {
  fetchDimensionAccountRows,
  getDimensionPnl,
  getFilteredPeriodFigures,
} from '@/modules/accounting/services/reports/dimensionPnlService';
import { bandsOf, isZeroResidual, type DimensionPnl } from '@/modules/accounting/services/reports/dimensionPnlColumns';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getIncomeStatementByDimension } from '@/modules/accounting/services/reports/incomeStatementByDimension';
import { getClassificationCoverage } from '@/modules/accounting/services/reports/classificationCoverageService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import { profitAndLossTool } from '@/lib/mcp/tools/reportsProfitAndLoss';
import type { McpToolContext } from '@/lib/mcp/types';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
const FROM = '2025-04-01';
const TO = '2025-04-30';
/** Company A's April P&L, worked from the seed. */
const NET = -1094.03;

describeIfDisposable('P&L by dimension on a real ledger', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let f: GlDimFixture;

  beforeAll(async () => { f = await seedGlDimensionFixture(pool, `dim-${Date.now()}`); }, 60_000);
  afterAll(async () => { await dropGlDimensionFixture(pool, f); await pool.end(); });

  const column = (p: DimensionPnl, code: string) => p.columns.find((c) => c.code === code);
  const net = async (filter: Parameters<typeof getFilteredPeriodFigures>[3]) =>
    bandsOf(await getFilteredPeriodFigures(f.a, FROM, TO, filter)).netProfit;

  it('the ungrouped April P&L: posted only, A only, the 30th included, no foreign account', async () => {
    const p = await getDimensionPnl(f.a, FROM, TO, 'cc1');
    expect(p.total).toEqual({
      turnover: -100, otherIncome: 50, costOfSales: 200, grossProfit: -300, operatingExpenses: 814.03,
      depreciation: 70, operatingProfit: -1064.03, otherExpenses: 30, netProfit: NET,
    });
    const is = await getIncomeStatement(f.a, FROM, TO);
    expect(is.netProfit).toBeCloseTo(NET, 2);
    expect(is.totalRevenue).toBeCloseTo(-100, 2);
  });

  it('group_by cc1 reads the effective CC1: legacy-only under FT, re-tagged under HT only', async () => {
    const p = await getDimensionPnl(f.a, FROM, TO, 'cc1');
    expect(p.columns.map((c) => [c.code, c.netProfit])).toEqual([
      ['FT', -199.01], ['HT', -800.01], ['UNKNOWN', -30], ['UNTAGGED', -65.01],
    ]);
    expect(column(p, 'FT')!.depreciation).toBe(70);
    expect(isZeroResidual(p.residual)).toBe(true);
    // B's cost centre is UNKNOWN here, never resolved to its code or name.
    expect(JSON.stringify(p)).not.toContain('SECRET');
    expect(column(p, 'UNKNOWN')!.memberId).toBe(f.cc.BX);
  });

  it('the cost-centre filter equals the member column, and the members sum to the company (REPRO 1)', async () => {
    expect(await net({ costCentreId: f.cc.FT })).toBe(-199.01);
    expect(await net({ costCentreId: f.cc.HT })).toBe(-800.01);
    const p = await getDimensionPnl(f.a, FROM, TO, 'cc1');
    const sumCents = p.columns.reduce((s, c) => s + Math.round(c.netProfit * 100), 0);
    expect(sumCents / 100).toBe(NET);
    // An FNO filter also takes the CC2 projects under it only by their own CC2 tag.
    expect(await net({ costCentreId: f.cc.P1 })).toBe(-100);
    expect(await net({ costCentreId: f.cc.P2 })).toBe(-340);
  });

  it('group_by cc2 and bu read their own columns', async () => {
    const cc2 = await getDimensionPnl(f.a, FROM, TO, 'cc2');
    expect(cc2.columns.map((c) => [c.code, c.parentCode, c.netProfit])).toEqual([
      ['P1', 'FT', -100], ['P2', 'HT', -340], ['UNKNOWN', null, -1], ['UNTAGGED', null, -653.03],
    ]);
    const bu = await getDimensionPnl(f.a, FROM, TO, 'bu');
    expect(bu.columns.map((c) => [c.code, c.netProfit])).toEqual([['B2', -300], ['UNKNOWN', -30], ['UNTAGGED', -764.03]]);
    expect(JSON.stringify([cc2, bu])).not.toContain('SECRET');
    expect(await net({ businessUnitId: f.bu.B2 })).toBe(-300);
  });

  it('rows carry only revenue and expense accounts', async () => {
    const rows = await fetchDimensionAccountRows(f.a, FROM, TO, null);
    expect(new Set(rows.map((r) => r.accountCode))).toEqual(new Set(['4000', '4900', '5000', '6000', '6100', '7000']));
  });

  it('the income-statement matrix honours the filter and ties to the filtered statement', async () => {
    const m = await getIncomeStatementByDimension(f.a, FROM, TO, 'bu', { costCentreId: f.cc.FT });
    expect(m.report.netProfit).toBeCloseTo(-199.01, 2);
    expect(isZeroResidual(m.residual)).toBe(true);
    expect(m.columns.reduce((s, c) => s + Math.round(c.netProfit * 100), 0) / 100).toBe(-199.01);
    const unfiltered = await getIncomeStatementByDimension(f.a, FROM, TO, 'cc1');
    expect(isZeroResidual(unfiltered.residual)).toBe(true);
    expect(unfiltered.report.netProfit).toBeCloseTo(NET, 2);
  });

  it('profit_and_loss restricts by business_unit_id and cost_centre_id', async () => {
    const ctx = { userId: f.user, companyId: f.a, scopes: ['read:reports'], tokenJti: null, oauthAppId: null } as McpToolContext;
    const call = async (args: Record<string, unknown>) => JSON.parse(
      (await profitAndLossTool.handler({ period_start: FROM, period_end: TO, ...args }, ctx)).content[0]!.text,
    ) as Record<string, unknown>;
    expect((await call({ business_unit_id: f.bu.B2 })).netProfit).toBe(-300);
    expect((await call({ cost_centre_id: f.cc.HT })).netProfit).toBe(-800.01);
    const grouped = await call({ group_by: 'cc1' });
    expect(grouped.netProfit).toBe(NET);
    expect((grouped.by_dimension as { ties: boolean }).ties).toBe(true);
  });

  it('classification coverage reads the same filter', async () => {
    const ft = await getClassificationCoverage(f.a, FROM, TO, f.cc.FT);
    expect(ft.expense.totalAmount).toBeCloseTo(199.01, 2);
    expect(ft.expense.unclassifiedAmount).toBeCloseTo(-70.99, 2);
    const b2 = await getClassificationCoverage(f.a, FROM, TO, undefined, f.bu.B2);
    expect(b2.expense.totalAmount).toBeCloseTo(300, 2);
    expect(b2.revenue.totalAmount).toBeCloseTo(0, 2);
  });

  it('the trial balance and the balance sheet use the same effective CC1', async () => {
    const opexOf = async (cc: string) => {
      const row = (await getTrialBalance(f.a, f.aprilPeriod, cc)).find((r) => r.accountCode === '6000');
      return row ? Math.round((row.debitBalance - row.creditBalance) * 100) / 100 : 0;
    };
    expect(await opexOf(f.cc.FT)).toBe(-70.99);
    expect(await opexOf(f.cc.HT)).toBe(800.01);
    // The prior year's re-tagged E00 (R50) is HT's retained brought forward, not FT's.
    const bf = async (cc: string) => {
      const row = (await getTrialBalance(f.a, f.aprilPeriod, cc)).find((r) => r.accountCode === 'RE-BF');
      return row ? Math.round((row.creditBalance - row.debitBalance) * 100) / 100 : 0;
    };
    expect(await bf(f.cc.FT)).toBe(0);
    expect(await bf(f.cc.HT)).toBe(-50);
    // Retained to date under FT: March's sale (1000) less April's FT costs (199.01).
    expect((await getEquityBases(f.a, TO, f.cc.FT)).derivedRetainedEarnings).toBeCloseTo(800.99, 2);
    expect((await getEquityBases(f.a, TO, f.cc.HT)).derivedRetainedEarnings).toBeCloseTo(-850.01, 2);
  });
});
