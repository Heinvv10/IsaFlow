/**
 * P&L by dimension against a real database (PR #688 review round 1): the SQL
 * the unit suites could only mock — tenancy on every read, posted only, an
 * inclusive period end, CC1 = cc1_id alone (the legacy cost_center_id is read
 * by no report — PR #688 round 2) in every filter and in the cc1 grouping, the
 * matrix honouring the filter, the MCP business_unit_id, the coverage
 * predicate, the trial balance / balance sheet / ledger drill-downs using the
 * same CC1, and a CC1 cleared by tag_journal_lines staying cleared.
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
import { getBalanceSheet, getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';
import { getAccountTransactions } from '@/modules/accounting/services/gl/accountTransactionsService';
import { resolveAccountEvidence } from '@/modules/accounting/services/core/evidenceGraphService';
import { planDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagPlan';
import { applyDimensionTags } from '@/modules/accounting/services/gl/dimensions/dimensionTagApply';
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

  it('group_by cc1 reads cc1_id: E04 under FT, re-tagged E14 under HT only, cleared E13 untagged', async () => {
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
    const ctx = { userId: f.user, companyId: f.a, scopes: ['read:reports'], companyRole: 'owner', tokenJti: null, oauthAppId: null } as McpToolContext;
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

  it('the trial balance and the balance sheet use the same CC1', async () => {
    const opexOf = async (cc: string) => {
      const row = (await getTrialBalance(f.a, f.aprilPeriod, cc)).find((r) => r.accountCode === '6000');
      return row ? Math.round((row.debitBalance - row.creditBalance) * 100) / 100 : 0;
    };
    expect(await opexOf(f.cc.FT)).toBe(-70.99);
    expect(await opexOf(f.cc.HT)).toBe(800.01);
    // The prior year's re-tagged E00 (R50) is HT's retained brought forward, not
    // FT's; its cleared R20 line is no one's.
    const bf = async (cc: string) => {
      const row = (await getTrialBalance(f.a, f.aprilPeriod, cc)).find((r) => r.accountCode === 'RE-BF');
      return row ? Math.round((row.creditBalance - row.debitBalance) * 100) / 100 : 0;
    };
    expect(await bf(f.cc.FT)).toBe(0);
    expect(await bf(f.cc.HT)).toBe(-50);
    // Retained to date under FT: March's sale (1000) less April's FT costs (199.01).
    expect((await getEquityBases(f.a, TO, f.cc.FT)).derivedRetainedEarnings).toBeCloseTo(800.99, 2);
    expect((await getEquityBases(f.a, TO, f.cc.HT)).derivedRetainedEarnings).toBeCloseTo(-850.01, 2);
    // No balance-sheet line carries CC1 or CC2 FT; E13's bank line only had it before it was cleared,
    // and so did a share issue posted here. (The balance sheet needs a retained-earnings account and
    // the share issue an equity one; the shared seed has neither, so both are added and removed.)
    const [re, capital, issue] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await pool.query(`INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, account_subtype,
                        normal_balance, is_system_account) VALUES ($1, $3, '3100', 'Retained', 'equity', 'retained_earnings', 'credit', true),
                        ($2, $3, '3000', 'Share capital', 'equity', NULL, 'credit', false)`, [re, capital, f.a]);
    await pool.query(`INSERT INTO gl_journal_entries(id, company_id, entry_number, entry_date, status, created_by, source)
                      VALUES ($1, $2, $3, '2025-04-02', 'posted', $4, 'manual')`, [issue, f.a, `GLX-ISSUE-${issue.slice(0, 8)}`, f.user]);
    await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id, company_id, gl_account_id, debit, credit, cost_center_id, description)
                      VALUES ($1, $2, $3, 40, 0, $5, 'issue'), ($1, $2, $4, 0, 40, $5, 'issue')`, [issue, f.a, f.acc.bank, capital, f.cc.FT]);
    try {
      const bs = await getBalanceSheet(f.a, TO, f.cc.FT);
      expect([bs.totalAssets, bs.totalLiabilities]).toEqual([0, 0]);
      expect((await getEquityBases(f.a, TO, f.cc.FT)).posted).toBe(0);
      expect((await getEquityBases(f.a, TO)).posted).toBe(40);
    } finally {
      await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [issue]);
      await pool.query('DELETE FROM gl_journal_entries WHERE id = $1', [issue]);
      await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id = ANY($1::UUID[])', [[re, capital]]);
      await pool.query('DELETE FROM gl_accounts WHERE id = ANY($1::UUID[])', [[re, capital]]);
    }
  });

  it('the ledger drill-downs agree with the trial balance under a cost-centre filter (REPRO C)', async () => {
    for (const [cc, expected] of [[f.cc.FT, -70.99], [f.cc.HT, 800.01]] as const) {
      const tb = (await getTrialBalance(f.a, f.aprilPeriod, cc)).find((r) => r.accountCode === '6000')!;
      expect(Math.round((tb.periodDebit - tb.periodCredit) * 100) / 100).toBe(expected);
      const ledger = await getAccountLedger({ companyId: f.a, accountCode: '6000', costCentreId: cc, fromDate: FROM, toDate: TO });
      expect(ledger.periodNet).toBe(expected);
      const tx = await getAccountTransactions(f.a, '6000', FROM, TO, cc);
      expect(tx.periodNet).toBe(expected);
      const evidence = await resolveAccountEvidence(f.a, f.acc.opex, { fromDate: FROM, toDate: TO, costCentreId: cc });
      expect(Math.round(evidence.reduce((s, r) => s + r.debit - r.credit, 0) * 100) / 100).toBe(expected);
    }
    // Every ledger query — opening, count, page, period; posted and all — ignores E13's cleared CC1.
    // All statuses: E06 (draft, 999) and E07 (reversed, 111) are FT's too.
    for (const [postedOnly, count, periodNet] of [[true, 3, -70.99], [false, 5, 1039.01]] as const) {
      const led = await getAccountLedger({ companyId: f.a, accountCode: '6000', costCentreId: f.cc.FT, fromDate: FROM, toDate: TO, postedOnly });
      expect([led.total, led.periodNet], String(postedOnly)).toEqual([count, periodNet]);
      expect(Math.round(led.rows.reduce((s, r) => s + r.debit - r.credit, 0) * 100) / 100).toBe(periodNet);
      const may = await getAccountLedger({ companyId: f.a, accountCode: '1000', costCentreId: f.cc.FT, fromDate: '2025-05-01', toDate: '2025-05-31', postedOnly });
      expect(may.openingBalance, String(postedOnly)).toBe(0);
    }
    expect((await getAccountTransactions(f.a, '1000', '2025-05-01', '2025-05-31', f.cc.FT)).openingBalance).toBe(0);
    // E15 sits on company B's account, whose code is also 4000: never in A's 4000 (the account join is A's).
    const sales = await getAccountTransactions(f.a, '4000', FROM, TO);
    expect(sales.transactions.map((t) => [t.debit, t.credit])).toEqual([[100, 0]]);
    // ... nor in its opening: March's sale (1000) less April's reversal of 100, without E15's 9.
    expect((await getAccountTransactions(f.a, '4000', '2025-05-01', '2025-05-31')).openingBalance).toBe(900);
    // Across the March year start: E00's cleared R20 (February) closes to no one, and every page's
    // running balance is the unpaged one.
    const whole = await getAccountLedger({ companyId: f.a, accountCode: '6000', costCentreId: f.cc.FT, fromDate: '2025-02-01', toDate: TO });
    expect(whole.closedToRetainedEarnings).toBe(0);
    for (let k = 1; k < whole.rows.length; k++) {
      const page = await getAccountLedger({ companyId: f.a, accountCode: '6000', costCentreId: f.cc.FT, fromDate: '2025-02-01', toDate: TO, limit: 1, offset: k });
      expect(page.rows[0]?.runningBalance, `offset ${k}`).toBe(whole.rows[k]!.runningBalance);
    }
  });

  // Last: it re-tags a line of the shared seed.
  it('clearing a CC1 with tag_journal_lines sticks in every report (REPRO B)', async () => {
    const [line] = (await pool.query(
      'SELECT id::TEXT AS id FROM gl_journal_lines WHERE journal_entry_id = $1 AND gl_account_id = $2', [f.e.E04, f.acc.dep],
    )).rows as Array<{ id: string }>;
    const plan = await planDimensionTags(f.a, [{ journalLineId: line!.id, cc1: null, unallocatedReason: 'not an FNO cost' }]);
    await applyDimensionTags(f.a, plan, { idempotencyKey: `clear-${f.e.E04}`, userId: f.user });
    const stored = (await pool.query('SELECT cc1_id, cost_center_id FROM gl_journal_lines WHERE id = $1', [line!.id])).rows[0];
    expect(stored).toEqual({ cc1_id: null, cost_center_id: f.cc.FT });
    const p = await getDimensionPnl(f.a, FROM, TO, 'cc1');
    expect(p.columns.map((c) => [c.code, c.netProfit])).toEqual([
      ['FT', -129.01], ['HT', -800.01], ['UNKNOWN', -30], ['UNTAGGED', -135.01],
    ]);
    expect(await net({ costCentreId: f.cc.FT })).toBe(-129.01);
    expect((await planDimensionTags(f.a, [{ journalLineId: line!.id, cc1: f.cc.HT }])).lines[0]!.old).toEqual({});
  });
});
