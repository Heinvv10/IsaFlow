/**
 * Every reader the G-01 census marks "exclude", as a callable table. The reader-table test runs the
 * whole table on a tenant that posted the year-end close and on an identical one that never did, and
 * the outputs must be equal. `anchors` stop an empty or erroring reader passing by being equally
 * empty on both: every reader's output must contain the fixture's own figures.
 */
import { vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Pool } from 'pg';
import type { G01Tenant } from './g01Fixture';
import type { McpTool, McpToolContext } from '../../../src/lib/mcp/types';
import { getIncomeStatement } from '../../../src/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet, getEquityBases } from '../../../src/modules/accounting/services/reports/balanceSheetService';
import { getTrialBalanceReport } from '../../../src/modules/accounting/services/gl/trialBalanceService';
import { getFinancialFigures } from '../../../src/modules/accounting/services/gl/financialFiguresService';
import { getGeneralLedgerReport } from '../../../src/modules/accounting/services/gl/generalLedgerReportService';
import { getGeneralLedgerLines } from '../../../src/modules/accounting/services/gl/generalLedgerStreamService';
import { getAccountTransactions } from '../../../src/modules/accounting/services/gl/accountTransactionsService';
import { getAccountLedger } from '../../../src/modules/accounting/services/reports/accountLedgerService';
import { listFiscalYears } from '../../../src/modules/accounting/services/gl/yearEndService';
import { getMonthlyMovements, getMonthlyBalances } from '../../../src/modules/accounting/services/reports/trendRowsService';
import { getProjectProfitability, getProjectTaggingCoverage } from '../../../src/modules/accounting/services/reports/projectProfitabilityService';
import { getClassificationCoverage } from '../../../src/modules/accounting/services/reports/classificationCoverageService';
import { getBudgetVariance } from '../../../src/modules/accounting/services/reports/budgetVarianceService';
import { readExtendedRatioInputs } from '../../../src/modules/accounting/services/reports/extendedRatioInputs';
import { getDashboardKPIs } from '../../../src/modules/accounting/services/reports/kpiDashboardService';
import { getRevenueChart, getTopExpenseCategories } from '../../../src/modules/accounting/services/reports/kpiChartsService';
import { getConsolidatedIncomeStatement, getConsolidatedBalanceSheet } from '../../../src/modules/accounting/services/reports/consolidatedStatementsService';
import { getConsolidatedTrialBalance } from '../../../src/modules/accounting/services/reports/consolidationService';
import { getGroupDashboardStats } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';
import { exportCaseWareTB } from '../../../src/modules/accounting/services/reports/casewareExportService';
import { getLedgerPostedThrough } from '../../../src/modules/accounting/services/reports/postedThroughService';
import { getUnusualJournals } from '../../../src/modules/accounting/services/reports/unusualJournalsService';
import { getChangesInEquity } from '../../../src/modules/accounting/services/afs/changesInEquityService';
import { getKpiScorecard } from '../../../src/modules/accounting/services/afs/afsKpiService';
import { computePisBreakdown, computePisScore } from '../../../src/modules/accounting/services/afs/pisCalculatorService';
import { getUnmappedAccounts, getMappedTrialBalance, getMappingStats } from '../../../src/modules/accounting/services/afs/afsMappingQueries';
import { runPreExportChecks } from '../../../src/modules/accounting/services/afs/afsPreExportChecks';
import { fetchBalancesByNote, fetchBalancesByCodes, fetchSubtypeBalances } from '../../../src/modules/accounting/services/afs/noteGenerators/noteHelpers';
import { fetchIncomeAgg, fetchTopMover } from '../../../src/modules/accounting/services/afs/managementPackGeneratorService';
import { getConsolidatedTrialBalance as getGroupTrialBalance } from '../../../src/modules/accounting/services/reports/consolidatedTrialBalanceReport';
import { getPackTrend } from '../../../src/modules/accounting/services/packs/packTrendService';
import { clientMetricsSnapshot } from '../../../src/modules/bureau/services/bureauClientMetricsService';
import * as primary from '../../../src/modules/accounting/services/afs/noteGenerators/primaryStatements';
import * as notes1 from '../../../src/modules/accounting/services/afs/noteGenerators/notes1to5';
import * as notes6 from '../../../src/modules/accounting/services/afs/noteGenerators/notes6to10';
import * as notes11 from '../../../src/modules/accounting/services/afs/noteGenerators/notes11to15';
import * as notes16 from '../../../src/modules/accounting/services/afs/noteGenerators/notes16to20';
import * as notes21 from '../../../src/modules/accounting/services/afs/noteGenerators/notes21to25';
import * as notes26 from '../../../src/modules/accounting/services/afs/noteGenerators/notes26to30';
import * as disclosure from '../../../src/modules/accounting/services/reports/disclosureNoteGenerators';
import { profitAndLossTool } from '../../../src/lib/mcp/tools/reportsProfitAndLoss';
import { trialBalanceTool } from '../../../src/lib/mcp/tools/reportsTrialBalance';
import { balanceSheetTool } from '../../../src/lib/mcp/tools/reportsBalanceSheet';
import { generalLedgerTool } from '../../../src/lib/mcp/tools/generalLedger';
import { budgetVarianceTool } from '../../../src/lib/mcp/tools/budgetVariance';
import managementAccounts from '../../../pages/api/accounting/reports-management-accounts';
import dashboardStats from '../../../pages/api/accounting/dashboard-stats';
import trendAnalysis from '../../../pages/api/accounting/reports-trend-analysis';
import cashFlowPage from '../../../pages/api/accounting/reports-cash-flow';
import cashFlowExport from '../../../pages/api/accounting/cash-flow-export';
import budgetPage from '../../../pages/api/accounting/reports-budget-vs-actual';
import budgetExport from '../../../pages/api/accounting/budget-vs-actual-export';

export interface Reader { name: string; run: () => Promise<unknown>; anchors: RegExp[] }

const FY25: [string, string] = ['2025-01-01', '2025-12-31'];
const FY26: [string, string] = ['2026-01-01', '2026-12-31'];
/** The fixture's own figures: FY2025 revenue and profit, and equity at the end of FY2025. */
export const REVENUE_25 = /1750/;
export const PROFIT_25 = /1050/;
export const EQUITY_25 = /11450/;

interface FakeRes { statusCode: number; headers: Record<string, unknown>; body: unknown }

/** Drive a Next API handler with auth stood in for (the suite mocks `withAuth` to a pass-through). */
async function route(handler: unknown, t: G01Tenant, query: Record<string, string>, now: string): Promise<FakeRes> {
  const out: FakeRes = { statusCode: 200, headers: {}, body: undefined };
  const res = {
    status(code: number) { out.statusCode = code; return res; },
    setHeader(k: string, v: unknown) { out.headers[k.toLowerCase()] = v; return res; },
    json(b: unknown) { out.body = b; return res; },
    send(b: unknown) { out.body = b; return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  const req = { method: 'GET', query, headers: {}, companyId: t.company, userId: 'u', userRole: 'owner' } as unknown as NextApiRequest;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  try { await (handler as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(req, res); } finally { vi.useRealTimers(); }
  return out;
}

async function atNow<T>(now: string, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  try { return await fn(); } finally { vi.useRealTimers(); }
}

async function tool(t: McpTool, ctx: McpToolContext, args: Record<string, unknown>): Promise<unknown> {
  return JSON.parse((await t.handler(args, ctx)).content[0]!.text);
}

/** Every exported `generate*` of a note module, called for FY2025; failures are returned, not thrown. */
async function allGenerators(mod: Record<string, unknown>, company: string, year = 2025): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(mod)) {
    if (!name.startsWith('generate') || typeof fn !== 'function') continue;
    try { out[name] = await (fn as (...a: unknown[]) => Promise<unknown>)(company, year, 'ifrs_smes'); }
    catch (err) { out[name] = { error: String((err as Error).message) }; }
  }
  return out;
}

export function readers(t: G01Tenant, user: string, pool: Pool): Reader[] {
  const c = t.company;
  const ctx = { userId: user, companyId: c, scopes: ['read:reports'], tokenJti: null, oauthAppId: null } as unknown as McpToolContext;
  const NOW = '2025-12-15T10:00:00';
  const R = (name: string, run: () => Promise<unknown>, ...anchors: RegExp[]): Reader => ({ name, run, anchors });
  return [
    R('income statement FY25', () => getIncomeStatement(c, ...FY25), REVENUE_25, PROFIT_25),
    R('income statement FY26 + prior column', () => getIncomeStatement(c, ...FY26, {}, { start: FY25[0], end: FY25[1] }), PROFIT_25),
    R('income statement FY25 cost centre A', () => getIncomeStatement(c, ...FY25, { costCentreId: t.ccA }), /1000/),
    R('income statement FY25 business unit', () => getIncomeStatement(c, ...FY25, { businessUnitId: t.bu }), /1000/),
    R('balance sheet FY25', () => getBalanceSheet(c, FY25[1]), EQUITY_25),
    R('balance sheet FY26 + compare', () => getBalanceSheet(c, FY26[1], undefined, FY25[1]), /11850/),
    R('balance sheet cost centre A', () => getBalanceSheet(c, FY25[1], t.ccA), /1000/),
    R('equity bases', () => getEquityBases(c, FY25[1]), /1450/),
    R('trial balance FY25', async () => (await getTrialBalanceReport(c, t.period.p25)).rows, REVENUE_25),
    R('trial balance FY26', async () => (await getTrialBalanceReport(c, t.period.p26)).rows, /1450/),
    R('trial balance FY25 business unit', async () => (await getTrialBalanceReport(c, t.period.p25, { businessUnitId: t.bu })).rows, /1000/),
    R('financial figures', () => getFinancialFigures(c, ...FY25), REVENUE_25, PROFIT_25),
    R('general ledger report FY26', () => getGeneralLedgerReport(c, ...FY26), /4000/),
    R('general ledger report FY25', () => getGeneralLedgerReport(c, ...FY25), /4000/),
    R('general ledger stream retained earnings opening', () => getGeneralLedgerLines({ companyId: c, periodStart: FY26[0], periodEnd: FY26[1], accountCodes: [t.reCode, '4000'], limit: 100 }), /4000/),
    R('general ledger stream FY25', () => getGeneralLedgerLines({ companyId: c, periodStart: FY25[0], periodEnd: FY25[1], limit: 100 }), /1000/),
    R('general ledger stream FY26 (opening)', () => getGeneralLedgerLines({ companyId: c, periodStart: FY26[0], periodEnd: FY26[1], limit: 100 }), /600/),
    R('account transactions 4000 FY25', () => getAccountTransactions(c, '4000', ...FY25), REVENUE_25),
    R('account transactions RE FY25', () => getAccountTransactions(c, t.reCode, ...FY25), new RegExp(t.reCode)),
    R('account transactions 4000 FY26', () => getAccountTransactions(c, '4000', ...FY26), /600/),
    R('account transactions RE FY26', () => getAccountTransactions(c, t.reCode, ...FY26), new RegExp(t.reCode)),
    R('account ledger 4000 FY25', () => getAccountLedger({ companyId: c, accountCode: '4000', fromDate: FY25[0], toDate: FY25[1] }), REVENUE_25),
    R('account ledger 4000 across the year end', () => getAccountLedger({ companyId: c, accountCode: '4000', fromDate: '2025-06-01', toDate: FY26[1] }), /600/),
    R('account ledger 4000 FY25 incl. drafts', () => getAccountLedger({ companyId: c, accountCode: '4000', fromDate: FY25[0], toDate: FY25[1], postedOnly: false }), REVENUE_25),
    R('account ledger 4000 across the year end incl. drafts', () => getAccountLedger({ companyId: c, accountCode: '4000', fromDate: '2025-06-01', toDate: FY26[1], postedOnly: false }), /600/),
    R('account ledger 4000 second page', () => getAccountLedger({ companyId: c, accountCode: '4000', fromDate: FY25[0], toDate: FY25[1], limit: 1, offset: 1 }), /4000/),
    R('account ledger RE FY26 (opening carries the posted close, not)', () => getAccountLedger({ companyId: c, accountCode: t.reCode, fromDate: FY26[0], toDate: FY26[1] }), /RECLS/),
    R('account ledger RE FY26 incl. drafts', () => getAccountLedger({ companyId: c, accountCode: t.reCode, fromDate: FY26[0], toDate: FY26[1], postedOnly: false }), /RECLS/),
    R('account ledger 4000 later page (net of the lines before it)', () => getAccountLedger({ companyId: c, accountCode: '4000', fromDate: FY25[0], toDate: FY26[1], limit: 2, offset: 4 }), /4000/),
    R('account ledger RE third page (net of the lines before it)', () => getAccountLedger({ companyId: c, accountCode: t.reCode, fromDate: FY25[0], toDate: FY26[1], limit: 1, offset: 2 }), new RegExp(`RE2|RECLS|${t.reCode}`)),
    R('account ledger 4000 page 3', () => getAccountLedger({ companyId: c, accountCode: '4000', fromDate: FY25[0], toDate: FY26[1], limit: 1, offset: 3 }), /4000/),
    R('account ledger RE (retained earnings)', () => getAccountLedger({ companyId: c, accountCode: t.reCode, fromDate: FY25[0], toDate: FY26[1] }), new RegExp(t.reCode)),
    R('account ledger 4000 cost centre A', () => getAccountLedger({ companyId: c, accountCode: '4000', costCentreId: t.ccA, fromDate: FY25[0], toDate: FY25[1] }), /1000/),
    R('fiscal years (year-end page)', () => listFiscalYears(c), PROFIT_25),
    R('monthly movements', () => getMonthlyMovements(c, FY25[1]), /1000/),
    R('monthly balances', () => getMonthlyBalances(c, FY25[1]), /1000/),
    R('project profitability (jobs basis)', () => getProjectProfitability(c, ...FY25, 'jobs'), /1000/),
    R('project tagging coverage (jobs basis)', () => getProjectTaggingCoverage(c, ...FY25, 'jobs'), /taggedLines/),
    R('project profitability (CC2 basis)', () => getProjectProfitability(c, ...FY25, 'cc2'), /1000/),
    R('project tagging coverage (CC2 basis)', () => getProjectTaggingCoverage(c, ...FY25, 'cc2'), /"taggedLines":1/),
    R('classification coverage', () => getClassificationCoverage(c, ...FY25), /1850/),
    R('budget variance', () => getBudgetVariance(c, ...FY25), REVENUE_25),
    R('ratio inputs', () => readExtendedRatioInputs(c, ...FY25, 0), REVENUE_25),
    R('dashboard KPIs', () => getDashboardKPIs(c, ...FY25), /1850/),
    R('dashboard KPIs FY26 (prior = FY25)', () => getDashboardKPIs(c, ...FY26), /1850/),
    R('revenue chart', () => getRevenueChart(c, 60), /1000/),
    R('top expense categories', () => getTopExpenseCategories(c, 5), /Rent/),
    R('consolidated income statement', () => getConsolidatedIncomeStatement(t.group, ...FY25), REVENUE_25),
    R('consolidated balance sheet', () => getConsolidatedBalanceSheet(t.group, FY25[1]), /16450/),
    R('consolidated trial balance', () => getConsolidatedTrialBalance(c, ...FY25), REVENUE_25),
    R('group trial balance FY26 (members, brought forward)', () => getGroupTrialBalance(t.group, ...FY26), /"credit":600/),
    R('group dashboard', () => atNow(NOW, () => getGroupDashboardStats(t.group)), /combinedRevenue/),
    R('CaseWare trial balance export', () => exportCaseWareTB(c, ...FY26), /4000/),
    R('posted through is the latest real posting', async () => {
      const through = await getLedgerPostedThrough(c, FY25[1], FY25[0]);
      const rows = await pool.query(
        "SELECT abs(extract(epoch FROM max(created_at) - $2::timestamptz)) < 0.002 AS ok FROM gl_journal_entries WHERE company_id=$1 AND source <> 'year_end' AND entry_date BETWEEN $3 AND $4",
        [c, through, FY25[0], FY25[1]]);
      return { postedThroughIsLatestRealPosting: rows.rows[0].ok };
    }, /true/),
    // Nine backdated journals: one short of a bulk load, so the close (a tenth) would tip it.
    R('unusual journals', () => getUnusualJournals(c, { start: FY25[0], end: FY25[1] }), /"bulkLoaded":null/),
    R('statement of changes in equity', () => getChangesInEquity(c, ...FY25), PROFIT_25, EQUITY_25),
    R('KPI scorecard', () => getKpiScorecard(c, '2025-12'), /debtToEquity/),
    R('PIS breakdown', () => computePisBreakdown(c, ...FY25), /"amount":1850/),
    R('PIS score', () => computePisScore(c, ...FY25), /\{/),
    R('unmapped accounts', () => getUnmappedAccounts(c), /\[\]|\{/),
    R('mapping stats', () => getMappingStats(c), /totalAccounts/),
    R('mapped trial balance (period, prior period)', () => getMappedTrialBalance(c, t.period.p25, t.period.p24), /1750|1000/),
    R('mapped trial balance FY26 with FY25 as prior', () => getMappedTrialBalance(c, t.period.p26, t.period.p25), /1750|600/),
    R('pack trend', () => getPackTrend(c, FY25[1], 12), /1000|1750/),
    R('bureau client metrics', () => atNow(NOW, () => clientMetricsSnapshot(c)), /16850/),
    R('AFS primary statements FY25', () => allGenerators(primary, c), EQUITY_25, REVENUE_25),
    R('AFS primary statements FY26 (opening accumulated income)', () => allGenerators(primary, c, 2026), /1450/),
    R('AFS notes 1-5', () => allGenerators(notes1, c), /\{/),
    R('AFS notes 6-10', () => allGenerators(notes6, c), /\{/),
    R('AFS note 12 (share capital and reserves)', () => allGenerators(notes11, c), /1[\s\u00a0]500,00/),
    R('AFS notes 16-20', () => allGenerators(notes16, c), REVENUE_25),
    R('AFS notes 21-25', () => allGenerators(notes21, c), /\{/),
    R('AFS notes 26-30', () => allGenerators(notes26, c), PROFIT_25),
    R('AFS notes 26-30 for FY24 (events after the reporting date)', () => allGenerators(notes26, c, 2024), /\{/),
    R('disclosure notes', async () => ({ ppe: await disclosure.notePPE(c, 2025), revenue: await disclosure.noteRevenue(c, 2025), cash: await disclosure.noteCash(c, 2025), tax: await disclosure.noteTaxation(c, 2025) }), /1[\s\u00a0]750/),
    R('AFS pre-export checks', () => runPreExportChecks(t.doc, c, 'ifrs_smes'), /\{/),
    R('AFS balances by note / by code', async () => ({ note: await fetchBalancesByNote(c, 8, 2025, 2024), codes: await fetchBalancesByCodes(c, ['IS002', 'BS045'], 2025, 2024), subtypes: await fetchSubtypeBalances(c, ['retained_earnings', 'depreciation_expense'], 2025) }), /1750|1450/),
    R('management pack figures', async () => ({ income: await fetchIncomeAgg(c, '2025-01-01', '2025-12-31'), top: await fetchTopMover(c, '2025-01-01', '2025-12-31', 'revenue') }), /1750/),
    R('group trial balance (members)', () => getGroupTrialBalance(t.group, ...FY25), REVENUE_25),
    R('MCP profit_and_loss', () => tool(profitAndLossTool, ctx, { period_start: FY25[0], period_end: FY25[1], group_by: 'cc1' }), PROFIT_25),
    R('MCP trial_balance', () => tool(trialBalanceTool, ctx, { fiscal_period_id: t.period.p26, detail: 'full' }), /1450/),
    R('MCP balance_sheet', () => tool(balanceSheetTool, ctx, { as_at: FY25[1], detail: 'full' }), EQUITY_25),
    R('MCP general_ledger', () => tool(generalLedgerTool, ctx, { period_start: FY26[0], period_end: FY26[1] }), /600/),
    R('MCP budget_variance', () => tool(budgetVarianceTool, ctx, { period_start: FY25[0], period_end: FY25[1], detail: 'full' }), REVENUE_25),
    R('page: management accounts', async () => (await route(managementAccounts, t, { period_start: FY25[0], period_end: FY25[1] }, NOW)).body, PROFIT_25, EQUITY_25),
    R('page: dashboard stats', async () => {
      // recentJournals is the raw journal list (the close is visible there by design), not a figure.
      const body = (await route(dashboardStats, t, {}, NOW)).body as { data?: { recentJournals?: unknown } };
      if (body.data) delete body.data.recentJournals;
      return body;
    }, /2350|1750|600/),
    R('page: trend analysis', async () => (await route(trendAnalysis, t, { metric: 'revenue', months: '12' }, '2026-01-15T10:00:00')).body, /"value":250/),
    R('page: cash flow', async () => (await route(cashFlowPage, t, { period_start: FY25[0], period_end: FY25[1] }, NOW)).body, PROFIT_25),
    R('export: cash flow csv', async () => (await route(cashFlowExport, t, { period_start: FY25[0], period_end: FY25[1] }, NOW)).body, PROFIT_25),
    R('page: budget vs actual (full year)', async () => (await route(budgetPage, t, { period: 'full_year' }, NOW)).body, /\{/),
    R('export: budget vs actual csv', async () => (await route(budgetExport, t, { period: 'full_year' }, NOW)).body, /Account|Budget/),
  ];
}
