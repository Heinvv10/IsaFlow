/**
 * Budgets P3 PR-D: `comparison_mode` drives the generated management pack, and
 * `income_vs_budget` / `budget_variance` print the tracking engine's figures.
 * The figures themselves are proven on real PostgreSQL in
 * tests/integration/management-pack-budget.int.test.ts; this file pins which
 * comparison each mode asks for and what each section is made of.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagementPackConfig } from '@/modules/accounting/services/afs/afsTypes';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  buildReport: vi.fn(),
  incomeReport: vi.fn(),
  balanceReport: vi.fn(),
  cashFlow: vi.fn(),
  arAging: vi.fn(),
  apAging: vi.fn(),
  unapplied: vi.fn(),
  recs: vi.fn(),
  bankAccounts: vi.fn(),
  cashBalance: vi.fn(),
  deliver: vi.fn(),
  createSection: vi.fn(),
  updateSection: vi.fn(),
  commentary: vi.fn(),
  summary: vi.fn(),
  capture: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: m.withSavepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.capture }));
vi.mock('@/modules/accounting/services/budgets/tracking/budgetTrackingService', () => ({ buildBudgetTrackingReport: m.buildReport }));
vi.mock('@/modules/accounting/services/reports/incomeStatementService', () => ({ getIncomeStatement: m.incomeReport }));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ getBalanceSheet: m.balanceReport }));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({ getCashFlowDirect: m.cashFlow }));
vi.mock('@/modules/accounting/services/ar/arAgingService', () => ({ getARAging: m.arAging }));
vi.mock('@/modules/accounting/services/ap/apAgingService', () => ({ getAPAging: m.apAging }));
vi.mock('@/modules/accounting/services/shared/agedNetting', () => ({ getUnappliedByEntity: m.unapplied }));
vi.mock('@/modules/accounting/services/bank/bankReconciliationService', () => ({ getReconciliations: m.recs }));
vi.mock('@/modules/accounting/services/bank/bankAccountStatusService', () => ({ getBankAccountsStatus: m.bankAccounts }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: m.cashBalance }));
vi.mock('@/modules/accounting/services/afs/afsDocumentService', () => ({ createAfsDocument: vi.fn(async () => ({ id: 'doc-1' })) }));
vi.mock('@/modules/accounting/services/afs/afsSectionService', () => ({ createAfsSection: m.createSection, updateAfsSection: m.updateSection }));
vi.mock('@/modules/accounting/services/afs/afsKpiService', () => ({
  fetchBalanceSnapshot: vi.fn(async () => ({})),
  getKpiScorecard: vi.fn(async () => ({ kpis: [] })),
}));
vi.mock('@/modules/accounting/services/afs/packAiSummaryService', async (importOriginal) => ({
  buildExecutiveSummaryPrompt: (await importOriginal<typeof import('@/modules/accounting/services/afs/packAiSummaryService')>()).buildExecutiveSummaryPrompt,
  generateExecutiveSummary: m.summary,
  generateSectionCommentary: m.commentary,
}));
vi.mock('@/modules/accounting/services/afs/packDeliveryService', () => ({ deliverPack: m.deliver }));

import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import { AGGS, balanceReportFor, band, config, generateWith, incomeReportFor, line, report, table, texts } from './managementPackFixtures';
import { comparisonPlan, topVarianceLines } from '@/modules/accounting/services/afs/managementPackComparison';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { buildExecutiveSummaryPrompt } from '@/modules/accounting/services/afs/packAiSummaryService';

const cashReport = (start: string, end: string) => ({
  periodStart: start, periodEnd: end, openingCash: 1000, operatingItems: [{ cashGroup: 'cash_received_from_customers', label: 'Cash received from customers', amount: 500 }],
  operatingTotal: 500, investingItems: [], investingTotal: 0, financingItems: [], financingTotal: 0, netChange: 500, closingCash: 1500,
});
const agingRows = (name: string) => [{ entityId: 'e', entityName: name, current: 100, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 100 }];
const reconciliation = () => ({
  id: 'r', bankAccountId: 'a', statementDate: '2026-09-30', statementBalance: 900, glBalance: 905, reconciledBalance: 880, difference: 20, status: 'completed',
  startedBy: 'u', startedAt: 's', createdAt: 'c', updatedAt: 'u', bankAccountName: 'Main',
});
const generate = (mode: ManagementPackConfig['comparisonMode'], sections: string[]) => generateWith(m.updateSection, mode, sections);

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('SELECT id FROM afs_documents')) return [];
    if (text.includes('COALESCE(SUM(CASE WHEN ga.account_type')) return [AGGS[String(values.find((v) => AGGS[String(v)]))] ?? {}];
    return [];
  });
  m.createSection.mockImplementation(async ({ sectionType }: { sectionType: string }) => ({ id: sectionType, sectionType }));
  m.updateSection.mockResolvedValue(undefined);
  m.commentary.mockResolvedValue('commentary');
  m.summary.mockResolvedValue('summary');
  m.buildReport.mockResolvedValue(report());
  m.incomeReport.mockImplementation(async (_co: string, start: string) => incomeReportFor(start));
  m.balanceReport.mockImplementation(async (_co: string, asAt: string) => balanceReportFor(asAt));
  m.cashFlow.mockImplementation(async (_co: string, start: string, end: string) => cashReport(start, end));
  m.arAging.mockImplementation(async () => agingRows('Customer A'));
  m.apAging.mockImplementation(async () => agingRows('Supplier A'));
  m.unapplied.mockResolvedValue(new Map([['e', { entityName: 'Customer A', payments: 20, creditNotes: 5, total: 25 }]]));
  m.recs.mockResolvedValue([reconciliation()]);
  m.bankAccounts.mockResolvedValue([{ id: 'a', accountName: 'Main', isActive: true, txnCount: 0 }, { id: 'z', accountName: 'Never Reconciled', isActive: true, txnCount: 0 }]);
  m.cashBalance.mockResolvedValue({ deactivatedWithBalance: [] });
  m.withSavepoint.mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn());
});

describe('comparisonPlan', () => {
  it.each([
    ['prior_month', { priorMonth: true, priorYear: false, budget: false }],
    ['prior_year', { priorMonth: false, priorYear: true, budget: false }],
    ['budget', { priorMonth: true, priorYear: false, budget: true }],
    ['all_three', { priorMonth: true, priorYear: true, budget: true }],
  ] as const)('%s', (mode, plan) => {
    expect(comparisonPlan(mode)).toEqual(plan);
  });
});

const row = (t: { rows: string[][] }, label: string) => t.rows.find((r) => r[0] === label);

describe('comparison_mode on the income statement section', () => {
  it('prior_month prints the report for the month and the month before, reads no budget and hands the AI the prior month', async () => {
    const out = await generate('prior_month', ['income_statement', 'ai_executive_summary']);
    const t = table(out.income_statement);
    expect(out.income_statement?.title).toBe('Income Statement');
    expect(t.headers).toEqual(['', 'This month', 'Prior month']);
    expect(row(t, 'Total revenue')).toEqual(['Total revenue', 'R 1 500.00', 'R 1 200.00']);
    expect(row(t, 'Net profit')).toEqual(['Net profit', 'R 300.00', 'R 250.00']);
    expect(m.incomeReport.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['co', '2026-09-01', '2026-09-30'], ['co', '2026-08-01', '2026-08-31'],
    ]);
    expect(m.buildReport).not.toHaveBeenCalled();
    expect(m.commentary.mock.calls[0]?.[0].priorData).toEqual({ revenue: 1200, cogs: 300, net_profit: 250 });
    expect(m.summary.mock.calls[0]?.[0]).toMatchObject({ priorRevenue: 1200, priorLabel: 'prior month' });
  });

  it('prior_year compares the same month a year earlier', async () => {
    const out = await generate('prior_year', ['income_statement', 'ai_executive_summary']);
    const t = table(out.income_statement);
    expect(t.headers).toEqual(['', 'This month', 'Same month last year', 'Change on last year']);
    expect(row(t, 'Total revenue')).toEqual(['Total revenue', 'R 1 500.00', 'R 900.00', 'R 600.00']);
    expect(row(t, 'Total cost of sales')).toEqual(['Total cost of sales', 'R 400.00', 'R 100.00', 'R 300.00']);
    expect(row(t, 'Net profit')).toEqual(['Net profit', 'R 300.00', 'R 200.00', 'R 100.00']);
    expect(m.commentary.mock.calls[0]?.[0].priorData).toEqual({ same_month_last_year: { revenue: 900, cogs: 100, net_profit: 200 } });
    expect(m.summary.mock.calls[0]?.[0]).toMatchObject({ priorRevenue: 900, priorLabel: 'the same month last year' });
  });

  it('budget adds the band table to the section when income_vs_budget is off', async () => {
    const out = await generate('budget', ['income_statement']);
    expect(out.income_statement?.blocks[0]?.type).toBe('table');
    expect(table(out.income_statement, 1).rows[0]).toEqual(['Turnover', 'R 1 500.00', 'R 1 000.00', 'R 500.00', '+50.0%', 'Favourable']);
  });

  it('budget does not print the band table twice when income_vs_budget is on', async () => {
    const out = await generate('budget', ['income_statement', 'income_vs_budget']);
    expect(out.income_statement?.blocks.filter((b) => b.type === 'table')).toHaveLength(1);
    expect(table(out.income_vs_budget).headers[0]).toBe('');
  });

  it('all_three adds the prior month, the prior year and the band table', async () => {
    const out = await generate('all_three', ['income_statement']);
    expect(table(out.income_statement).headers).toEqual(['', 'This month', 'Prior month', 'Same month last year', 'Change on last year']);
    expect(row(table(out.income_statement), 'Total revenue')).toEqual(['Total revenue', 'R 1 500.00', 'R 1 200.00', 'R 900.00', 'R 600.00']);
    expect(table(out.income_statement, 1).headers).toEqual(['', 'Actual', 'Budget', 'Var R', 'Var %', 'Position']);
    expect(m.commentary.mock.calls[0]?.[0].priorData).toEqual({
      prior_month: { revenue: 1200, cogs: 300, net_profit: 250 }, same_month_last_year: { revenue: 900, cogs: 100, net_profit: 200 },
    });
  });

  it('a month with no postings prints a sentence under the statement', async () => {
    m.incomeReport.mockImplementation(async () => incomeReportFor('none'));
    const out = await generate('prior_month', ['income_statement']);
    expect(texts(out.income_statement)).toEqual(['No income or expenses were posted in this period.']);
  });

  it('a statement that cannot be read says so, and the pack still generates', async () => {
    const refusal = new MissingSystemAccountError('retained_earnings', 'co', 'no_claimant', []);
    m.incomeReport.mockRejectedValue(refusal);
    const out = await generate('prior_month', ['income_statement', 'kpi_scorecard']);
    expect(out.income_statement?.blocks).toEqual([{ type: 'paragraph', text: 'This statement could not be produced for this period.' }]);
    expect(out.kpi_scorecard?.title).toBe('KPI Scorecard');
    expect(m.withSavepoint.mock.calls.map((c) => c[0])).toContain('mgmt_pack_income');
    expect(m.log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ statement: 'income', error: refusal.message }), 'managementPackGeneratorService');
    expect(JSON.stringify(out)).not.toContain(refusal.message);
  });
});

describe('the other pack sections', () => {
  it('the balance sheet is the report\'s statement, dated, with the AI told its own figures', async () => {
    const out = await generate('prior_year', ['balance_sheet']);
    const t = table(out.balance_sheet);
    expect(out.balance_sheet?.title).toBe('Balance Sheet');
    expect(t.headers).toEqual(['', '30 September 2026', '30 September 2025', 'Change on last year']);
    expect(row(t, 'Total assets')).toEqual(['Total assets', 'R 9 000.00', 'R 9 000.00', 'R 0.00']);
    expect(m.balanceReport.mock.calls.map((c) => c[1])).toEqual(['2026-09-30', '2025-09-30']);
    expect(m.commentary.mock.calls[0]?.[0]).toMatchObject({
      sectionType: 'balance_sheet', sectionData: { asAtDate: '2026-09-30', totalAssets: 9000 },
    });
  });

  it('every section is titled from the vocabulary; a section without a generator has no commentary and no figures', async () => {
    const out = await generate('prior_month', ['cover', 'ai_executive_summary', 'revenue_analysis', 'vat_dashboard']);
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.title]))).toEqual({
      cover: 'Cover Page', ai_executive_summary: 'AI Executive Summary', revenue_analysis: 'Revenue Analysis', vat_dashboard: 'VAT Dashboard',
    });
    expect(m.commentary).not.toHaveBeenCalled();
    expect(m.balanceReport).not.toHaveBeenCalled();
    const snaps = (m.updateSection.mock.calls as [string, string, string, { dataSnapshot?: unknown }][]).map((c) => c[3].dataSnapshot).filter((d) => d !== undefined);
    expect(snaps).toEqual([{}, {}, {}, {}]);
  });

  it('the AI failure sentences are not stored as commentary or as the summary', async () => {
    m.commentary.mockResolvedValue('AI commentary unavailable for this section.');
    m.summary.mockResolvedValue('AI summary unavailable for this period.');
    await generate('prior_month', ['ai_executive_summary', 'income_statement']);
    const patches = (m.updateSection.mock.calls as [string, string, string, { aiNarrative?: string }][]).map((c) => c[3]);
    expect(patches.some((p) => p.aiNarrative !== undefined)).toBe(false);
    m.updateSection.mockClear();
    m.commentary.mockResolvedValue('Revenue grew.');
    m.summary.mockResolvedValue('A good month.');
    await generate('prior_month', ['ai_executive_summary', 'income_statement']);
    const narratives = (m.updateSection.mock.calls as [string, string, string, { aiNarrative?: string }][]).filter((c) => c[3].aiNarrative).map((c) => [c[0], c[3].aiNarrative]);
    expect(narratives).toEqual(expect.arrayContaining([['income_statement', 'Revenue grew.'], ['ai_executive_summary', 'A good month.']]));
  });
});

describe('the budget sections', () => {
  it('asks the engine for the pack month, on the primary version, before the document exists', async () => {
    await generate('budget', ['income_vs_budget']);
    expect(m.buildReport).toHaveBeenCalledTimes(1);
    expect(m.buildReport.mock.calls[0]?.slice(0, 2)).toEqual(['co', { period: 'month', month: '2026-09' }]);
  });

  it('reads the budget for an enabled section under any mode', async () => {
    const out = await generate('prior_month', ['income_vs_budget']);
    expect(table(out.income_vs_budget).rows).toHaveLength(2);
  });

  it('income_vs_budget prints the engine bands, "—" for absent, and names the version and the unbudgeted actuals', async () => {
    const out = await generate('budget', ['income_vs_budget']);
    expect(out.income_vs_budget?.title).toBe('Income vs Budget');
    expect(table(out.income_vs_budget).rows[1]).toEqual(['Net profit', 'R 300.00', '—', '—', '—', '—']);
    expect(texts(out.income_vs_budget)).toEqual(expect.arrayContaining([
      'Budget version: Original · approved.',
      '1 account carries actuals but no budget: expenses R 100.00.',
    ]));
  });

  it('a budgeted zero prints R 0.00, not the dash', async () => {
    m.buildReport.mockResolvedValue(report({ bands: [band('revenue', 'Turnover', 0, 0)] }));
    const out = await generate('budget', ['income_vs_budget']);
    expect(table(out.income_vs_budget).rows[0]).toEqual(['Turnover', 'R 0.00', 'R 0.00', 'R 0.00', '—', 'Favourable']);
  });

  it('budget_variance prints the lines by |variance|, without unbudgeted lines', async () => {
    const out = await generate('budget', ['budget_variance']);
    expect(out.budget_variance?.title).toBe('Budget Variance');
    expect(table(out.budget_variance).rows.map((r) => r[0])).toEqual(['6100 Acc 6100', '6000 Acc 6000']);
  });

  it('topVarianceLines keeps ten, largest first, and drops a line on budget', () => {
    const lines = Array.from({ length: 12 }, (_, i) => line(String(1000 + i), i));
    const top = topVarianceLines(lines);
    expect(top).toHaveLength(10);
    expect(top[0]?.variance).toBe(11);
    expect(top.some((l) => l.variance === 0)).toBe(false);
  });

  it('a year with no budget prints the sentence, never an empty table', async () => {
    m.buildReport.mockResolvedValue(report({ notices: { ...report().notices, noVersion: true } }));
    const out = await generate('budget', ['income_vs_budget', 'budget_variance']);
    for (const s of ['income_vs_budget', 'budget_variance']) {
      expect(out[s]?.blocks).toEqual([{ type: 'paragraph', text: 'No budget for FY2027 in this pack\'s month.' }]);
    }
  });

  it('the month in progress says how far the actuals run', async () => {
    m.buildReport.mockResolvedValue(report({ window: { ...report().window, inProgress: { month: '2026-09', actualsTo: '2026-09-12' } } }));
    const out = await generate('budget', ['income_vs_budget']);
    expect(texts(out.income_vs_budget)).toContain('2026-09 is in progress; actuals posted through 2026-09-12.');
  });

  const UNAVAILABLE = [{ type: 'paragraph', text: 'Budget figures are unavailable for this month.' }];

  it.each([
    ['a tracking refusal', new TrackingError(409, 'FY2027 (id 1234) does not run on calendar months'), 'warn'],
    ['a version refusal', new BudgetVersionError('NOT_FOUND', 'version abc not found'), 'warn'],
    ['any other failure', new Error('relation "budget_versions" does not exist'), 'error'],
  ] as const)('%s prints the fixed sentence in every budget section, logs the reason, and the pack still generates', async (_n, err, level) => {
    m.buildReport.mockRejectedValue(err);
    const out = await generate('budget', ['income_statement', 'income_vs_budget', 'budget_variance']);
    expect(out.income_vs_budget?.blocks).toEqual(UNAVAILABLE);
    expect(out.budget_variance?.blocks).toEqual(UNAVAILABLE);
    // income_vs_budget is on, so the income statement section prints no budget block of its own.
    expect(out.income_statement?.blocks.slice(1)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(err.message);
    expect(m.log[level]).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ error: err.message }), 'managementPackComparison');
    const snap = (m.updateSection.mock.calls as [string, string, string, { dataSnapshot?: unknown }][]).find((c) => c[0] === 'budget_variance')?.[3].dataSnapshot;
    expect(snap).toEqual({ unavailable: 'Budget figures are unavailable for this month.' });
  });

  it('reports a non-refusal engine fault to Bugsink when Sentry is on, and never a refusal', async () => {
    vi.stubEnv('SENTRY_ENABLED', 'true');
    try {
      const fault = new Error('boom');
      m.buildReport.mockRejectedValueOnce(fault);
      await generate('budget', ['income_vs_budget']);
      expect(m.capture).toHaveBeenCalledWith(fault, { tags: { company_id: 'co', route: 'management-pack' } });
      m.capture.mockClear();
      m.updateSection.mockClear();
      m.buildReport.mockRejectedValueOnce(new TrackingError(409, 'not calendar months'));
      await generate('budget', ['income_vs_budget']);
      expect(m.capture).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not report to Bugsink when Sentry is off, and a failed capture is only a warning', async () => {
    vi.stubEnv('SENTRY_ENABLED', 'false');
    m.buildReport.mockRejectedValueOnce(new Error('boom'));
    await generate('budget', ['income_vs_budget']);
    expect(m.capture).not.toHaveBeenCalled();
    vi.stubEnv('SENTRY_ENABLED', 'true');
    try {
      m.capture.mockImplementationOnce(() => { throw new Error('sentry down'); });
      m.buildReport.mockRejectedValueOnce(new Error('boom'));
      m.updateSection.mockClear();
      const out = await generate('budget', ['income_vs_budget']);
      expect(out.income_vs_budget?.blocks).toEqual(UNAVAILABLE);
      expect(m.log.warn).toHaveBeenCalledWith('management pack: Sentry capture failed', { error: 'sentry down' }, 'managementPackComparison');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads the budget inside a savepoint, so a failed query cannot abort the request transaction the pack is written in', async () => {
    await generate('budget', ['income_vs_budget']);
    expect(m.withSavepoint).toHaveBeenCalledTimes(1);
    expect(m.withSavepoint.mock.calls[0]?.[0]).toBe('mgmt_pack_budget');
    expect(m.buildReport).toHaveBeenCalledTimes(1);
  });

  it('budget mode with income_vs_budget off puts the no-budget sentence in the income statement section', async () => {
    m.buildReport.mockResolvedValue(report({ notices: { ...report().notices, noVersion: true } }));
    const out = await generate('budget', ['income_statement']);
    expect(out.income_statement?.blocks.slice(1)).toEqual([{ type: 'paragraph', text: 'No budget for FY2027 in this pack\'s month.' }]);
  });

  it('budget mode with income_vs_budget off and no engine report puts the unavailable sentence there', async () => {
    m.buildReport.mockRejectedValue(new Error('boom'));
    const out = await generate('budget', ['income_statement']);
    expect(out.income_statement?.blocks.slice(1)).toEqual(UNAVAILABLE);
  });

  it('budget_variance with every budgeted line on budget says so instead of an empty table', async () => {
    m.buildReport.mockResolvedValue(report({ lines: [line('6000', 0), line('6200', null)] }));
    const out = await generate('budget', ['budget_variance']);
    expect(out.budget_variance?.blocks[0]).toEqual({ type: 'paragraph', text: 'No budgeted account is off budget this month.' });
  });

  it('the executive summary prompt names what each prior figure is', () => {
    const prompt = buildExecutiveSummaryPrompt({
      companyName: 'Co', period: '2026-09', revenue: 1500, priorRevenue: 900, priorLabel: 'the same month last year',
      grossMarginPct: 40, priorGrossMarginPct: 35, ebitda: 0, closingCash: 0, cashChange: 0, debtorDays: 30,
      priorDebtorDays: 28, overdueDebtors: 0, topRevenueAccount: 'a', revenueMovement: 1, topExpenseAccount: 'b', expenseMovement: 1, kpis: [],
    });
    expect(prompt).toContain('(the same month last year: R900)');
    expect(prompt).toContain('Gross margin: 40.0% (prior month: 35.0%)');
    expect(prompt).toContain('Debtor days: 30 (prior month: 28)');
    const byDefault = buildExecutiveSummaryPrompt({
      companyName: 'Co', period: '2026-09', revenue: 1, priorRevenue: 2, grossMarginPct: 0, priorGrossMarginPct: null, ebitda: 0, closingCash: 0,
      cashChange: 0, debtorDays: 0, priorDebtorDays: null, overdueDebtors: 0, topRevenueAccount: 'a', revenueMovement: 0, topExpenseAccount: 'b', expenseMovement: 0, kpis: [],
    });
    expect(byDefault).toMatch(/Revenue: R\S+ \(prior month: R2\)/);
  });

  it('snapshots the printed figures and asks no AI commentary on a budget section', async () => {
    await generate('budget', ['income_statement', 'income_vs_budget', 'budget_variance']);
    expect(m.commentary.mock.calls.map((c) => c[0].sectionType)).toEqual(['income_statement']);
    const snap = (m.updateSection.mock.calls as [string, string, string, { dataSnapshot?: Record<string, unknown> }][])
      .find((c) => c[0] === 'income_vs_budget')?.[3].dataSnapshot;
    expect(snap).toMatchObject({ version: 'Original · approved', bands: [{ key: 'revenue', actual: 1500, budget: 1000 }, { key: 'net_profit', budget: null }] });
  });
});

describe('the stored and narrated figures are the statement\'s own (turnover, not turnover plus other income)', () => {
  // Other income of 150 sits beside 1500 of turnover: the old aggregate called 1650 "revenue".
  const withOtherIncome = (start: string) => {
    const r = incomeReportFor(start);
    return start === '2026-09-01'
      ? { ...r, otherIncome: [{ accountCode: '4300', accountName: 'Other Income', amount: 150 }], totalOtherIncome: 150, operatingProfit: r.operatingProfit + 150, netProfit: r.netProfit + 150 }
      : r;
  };
  beforeEach(() => { m.incomeReport.mockImplementation(async (_c: string, start: string) => withOtherIncome(start)); });

  it('the snapshot, the section commentary and the executive summary use the table\'s Total revenue and net profit', async () => {
    const out = await generate('prior_month', ['income_statement', 'ai_executive_summary']);
    expect(row(table(out.income_statement), 'Total revenue')?.[1]).toBe('R 1 500.00');
    expect(m.commentary.mock.calls[0]?.[0].sectionData).toEqual({ revenue: 1500, cogs: 400, net_profit: 450 });
    expect(m.summary.mock.calls[0]?.[0]).toMatchObject({ revenue: 1500, priorRevenue: 1200 });
    const snap = (m.updateSection.mock.calls as [string, string, string, { dataSnapshot?: Record<string, unknown> }][])
      .find((c) => c[0] === 'income_statement' && c[3].dataSnapshot)?.[3].dataSnapshot;
    expect(snap).toEqual({ revenue: 1500, cogs: 400, net_profit: 450 });
  });

  it('asks for no executive summary when the section is off, and reads no income statement for nothing', async () => {
    await generate('prior_month', ['kpi_scorecard']);
    expect(m.summary).not.toHaveBeenCalled();
    expect(m.incomeReport).not.toHaveBeenCalled();
  });
});

describe('an income statement that could not be read', () => {
  it('gets no AI commentary and the pack gets no executive summary about figures it does not print', async () => {
    m.incomeReport.mockRejectedValue(new MissingSystemAccountError('retained_earnings', 'co', 'no_claimant', []));
    const out = await generate('prior_month', ['income_statement', 'ai_executive_summary', 'balance_sheet']);
    expect(out.income_statement?.blocks).toEqual([{ type: 'paragraph', text: 'This statement could not be produced for this period.' }]);
    expect((m.commentary.mock.calls as { sectionType: string }[][]).map((c) => c[0]?.sectionType)).toEqual(['balance_sheet']);
    expect(m.summary).not.toHaveBeenCalled();
  });
});

describe('what a failed statement read does', () => {
  it.each([
    ['a programming fault', new TypeError("Cannot read properties of undefined (reading 'balance')")],
    ['a database fault', Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' })],
  ])('%s aborts the pack before any document is created, so it is never signed off or delivered', async (_label, fault) => {
    const { createAfsDocument } = await import('@/modules/accounting/services/afs/afsDocumentService');
    const { deliverPack } = await import('@/modules/accounting/services/afs/packDeliveryService');
    m.balanceReport.mockRejectedValue(fault);
    await expect(generate('prior_month', ['income_statement', 'balance_sheet'])).rejects.toBe(fault);
    expect(createAfsDocument).not.toHaveBeenCalled();
    expect(m.updateSection).not.toHaveBeenCalled();
    expect(deliverPack).not.toHaveBeenCalled();
    expect(m.log.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ statement: 'balance', errorClass: fault.name }), 'managementPackGeneratorService');
  });

  it('a missing system account is a refusal: a warning, nothing sent to Bugsink', async () => {
    vi.stubEnv('SENTRY_ENABLED', 'true');
    try {
      m.balanceReport.mockRejectedValue(new MissingSystemAccountError('retained_earnings', 'co', 'no_claimant', []));
      await generate('prior_month', ['balance_sheet']);
      expect(m.capture).not.toHaveBeenCalled();
      expect(m.log.warn).toHaveBeenCalledWith(expect.stringContaining('no system account'), expect.objectContaining({ statement: 'balance' }), 'managementPackGeneratorService');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the reads inside the savepoint run one after another, so none lands after a ROLLBACK TO', async () => {
    let open = 0, max = 0;
    m.incomeReport.mockImplementation(async (_c: string, start: string) => {
      open += 1; max = Math.max(max, open);
      await new Promise((r) => setTimeout(r, 5));
      open -= 1;
      return incomeReportFor(start);
    });
    await generate('all_three', ['income_statement']);
    expect(m.incomeReport).toHaveBeenCalledTimes(3);
    expect(max).toBe(1);
  });
});

describe('the cash flow, ageing and bank reconciliation sections', () => {
  const SECTIONS = ['cash_flow', 'debtors_ageing', 'creditors_ageing', 'bank_reconciliation'];

  it('a deactivated bank account stays listed unless nothing ever happened on it', async () => {
    const inactive = (id: string, accountName: string, txnCount = 0) => ({ id, accountName, isActive: false, txnCount });
    m.bankAccounts.mockResolvedValue([
      { id: 'a', accountName: 'Main', isActive: true, txnCount: 5 },
      inactive('lines', 'Closed With Statement Lines Netting To Nil', 2),
      inactive('gl', 'Closed With Ledger Balance Only'),
      inactive('session', 'Closed With Old Session'),
      inactive('empty', 'Retired Empty'),
    ]);
    m.cashBalance.mockResolvedValue({ deactivatedWithBalance: [{ accountId: 'gl', glBalance: 6550 }] });
    m.recs.mockResolvedValue([reconciliation(), { ...reconciliation(), id: 'r2', bankAccountId: 'session', status: 'in_progress' }]);
    const out = await generate('all_three', ['bank_reconciliation']);
    expect(table(out.bank_reconciliation).rows.map((r) => [r[0], r[1]])).toEqual([
      ['Closed With Ledger Balance Only', 'No reconciliation'],
      ['Closed With Old Session', 'No reconciliation'],
      ['Closed With Statement Lines Netting To Nil', 'No reconciliation'],
      ['Main', '30 September 2026'],
    ]);
  });

  it('read each report for the pack month: windows, as-at dates and sides', async () => {
    const out = await generate('all_three', SECTIONS);
    expect(m.cashFlow.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      ['co', '2026-09-01', '2026-09-30'], ['co', '2026-08-01', '2026-08-31'], ['co', '2025-09-01', '2025-09-30'],
    ]);
    // The services the Aged Debtors / Creditors screens call, as at the month end.
    expect(m.arAging.mock.calls).toEqual([['co', '2026-09-30']]);
    expect(m.apAging.mock.calls).toEqual([['co', '2026-09-30']]);
    expect(m.unapplied.mock.calls).toEqual([['co', 'ar', '2026-09-30'], ['co', 'ap', '2026-09-30']]);
    expect(m.recs).toHaveBeenCalledWith('co');
    expect(m.bankAccounts).toHaveBeenCalledWith('co', { includeInactive: true });
    expect(m.cashBalance).toHaveBeenCalledWith('co', '2026-09-30');
    expect(table(out.cash_flow).headers).toEqual(['', 'This month', 'Prior month', 'Same month last year', 'Change on last year']);
    expect(table(out.debtors_ageing).rows[0]?.[0]).toBe('Customer A');
    expect(table(out.creditors_ageing).rows[0]?.[0]).toBe('Supplier A');
    expect(table(out.bank_reconciliation).rows).toEqual([
      ['Main', '30 September 2026', 'R 900.00', 'R 905.00', 'R 880.00', '−R 5.00'],
      ['Never Reconciled', 'No reconciliation', '—', '—', '—', '—'],
    ]);
    for (const [k, title] of [['cash_flow', 'Cash Flow'], ['debtors_ageing', 'Debtors Ageing'], ['creditors_ageing', 'Creditors Ageing'], ['bank_reconciliation', 'Bank Reconciliation']] as const) {
      expect(out[k]?.title).toBe(title);
    }
  });

  it('an entity with only unapplied credit is listed in the unapplied note', async () => {
    m.unapplied.mockResolvedValue(new Map([
      ['e', { entityName: 'Customer A', payments: 20, creditNotes: 5, total: 25 }],
      ['x', { entityName: 'Credit Only Co', payments: 0, creditNotes: 40, total: 40 }],
    ]));
    const out = await generate('prior_month', ['debtors_ageing']);
    expect(texts(out.debtors_ageing)).toContain('Customers with credit and no open document, so in no row above: Credit Only Co (R 40.00).');
  });

  it('read nothing when the sections are off', async () => {
    await generate('prior_month', ['kpi_scorecard']);
    for (const mock of [m.cashFlow, m.arAging, m.apAging, m.unapplied, m.recs, m.bankAccounts]) expect(mock).not.toHaveBeenCalled();
  });

  it('the snapshot and the AI commentary carry each section\'s own figures, and no customer or supplier name', async () => {
    await generate('prior_month', SECTIONS);
    const told = Object.fromEntries((m.commentary.mock.calls as { sectionType: string; sectionData: Record<string, unknown>; priorData: unknown }[][]).map((c) => [c[0]?.sectionType, c[0]]));
    expect(Object.keys(told).sort()).toEqual([...SECTIONS].sort());
    expect(told.cash_flow?.sectionData).toMatchObject({ openingCash: 1000, closingCash: 1500, netChange: 500 });
    expect(told.cash_flow?.priorData).toMatchObject({ closingCash: 1500 });
    expect(told.debtors_ageing?.sectionData).toMatchObject({ asAt: '2026-09-30', totals: { total: 100 }, entities: 1, unapplied: 25, largestBalances: [100], creditOnlyEntities: 0 });
    expect(told.creditors_ageing?.sectionData).toMatchObject({ largestBalances: [100] });
    expect(told.bank_reconciliation?.sectionData).toMatchObject({ accounts: [{ statementLessGl: -5 }], accountsWithoutReconciliation: 1 });
    expect(JSON.stringify(told.bank_reconciliation)).not.toMatch(/Main|Never Reconciled/);
    expect(told.debtors_ageing?.priorData).toBeNull();
    // Privacy: the model gets buckets and amounts, never who owes or is owed.
    expect(JSON.stringify([told.debtors_ageing, told.creditors_ageing])).not.toMatch(/Customer A|Supplier A/);
    const snap = (id: string) => (m.updateSection.mock.calls as [string, string, string, { dataSnapshot?: Record<string, unknown> }][]).find((c) => c[0] === id && c[3].dataSnapshot)?.[3].dataSnapshot;
    expect(snap('cash_flow')).toMatchObject({ closingCash: 1500 });
    expect(snap('creditors_ageing')).toMatchObject({ totals: { total: 100 } });
    expect(JSON.stringify([snap('debtors_ageing'), snap('creditors_ageing')])).not.toMatch(/Customer A|Supplier A/);
  });

  it.each([
    ['cash_flow', () => m.cashFlow, 'This statement could not be produced for this period.'],
    ['debtors_ageing', () => m.arAging, 'This report could not be produced for this period.'],
    ['creditors_ageing', () => m.apAging, 'This report could not be produced for this period.'],
    ['bank_reconciliation', () => m.recs, 'This report could not be produced for this period.'],
  ] as const)('%s that is refused (no system account) says so, gets no commentary, and the rest of the pack is whole', async (section, mock, sentence) => {
    mock().mockRejectedValue(new MissingSystemAccountError('retained_earnings', 'co', 'no_claimant', []));
    const out = await generate('prior_month', [...SECTIONS, 'kpi_scorecard']);
    expect(out[section]?.blocks).toEqual([{ type: 'paragraph', text: sentence }]);
    expect((m.commentary.mock.calls as { sectionType: string }[][]).map((c) => c[0]?.sectionType)).not.toContain(section);
    expect(out.kpi_scorecard?.title).toBe('KPI Scorecard');
    expect(m.withSavepoint.mock.calls.map((c) => c[0])).toContain(`mgmt_pack_${section}`);
    // The log names the report that was refused.
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringContaining(`the ${section} report could not be read`), expect.anything(), 'managementPackGeneratorService');
  });
});

describe('any other fault in a report read aborts the pack, and says which report', () => {
  it.each([
    ['cash_flow', () => m.cashFlow],
    ['debtors_ageing', () => m.arAging],
    ['creditors_ageing', () => m.apAging],
    ['bank_reconciliation', () => m.recs],
  ] as const)('%s: no document is created, nothing is delivered', async (section, mock) => {
    const { createAfsDocument } = await import('@/modules/accounting/services/afs/afsDocumentService');
    const fault = Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
    mock().mockRejectedValue(fault);
    await expect(generate('prior_month', ['cash_flow', 'debtors_ageing', 'creditors_ageing', 'bank_reconciliation'])).rejects.toBe(fault);
    expect(createAfsDocument).not.toHaveBeenCalled();
    expect(m.updateSection).not.toHaveBeenCalled();
    expect(m.deliver).not.toHaveBeenCalled();
    expect(m.log.error).toHaveBeenCalledWith(expect.stringContaining(`the ${section} report read failed`), expect.anything(), 'managementPackGeneratorService');
  });
});

describe('a pack with a section that could not be produced is not signed off or delivered by itself', () => {
  const noReview = (sections: string[]) => ({ ...config('prior_month', sections), reviewRequired: false });
  const run = (sections: string[], review = false) =>
    generateManagementPack({ companyId: 'co', period: '2026-09', config: review ? config('prior_month', sections) : noReview(sections), triggeredBy: 'cron' });
  const statusWritten = () => (m.sql.mock.calls as [TemplateStringsArray, ...unknown[]][]).find((c) => c[0].join('?').includes('UPDATE afs_documents SET status'))?.[1];

  it('review off, everything produced: signed off and delivered, as before', async () => {
    const r = await run(['income_statement', 'cash_flow', 'debtors_ageing']);
    expect(r).toMatchObject({ status: 'signed_off', deliveryScheduled: true });
    expect(m.deliver).toHaveBeenCalledTimes(1);
    expect(statusWritten()).toBe('signed_off');
  });

  it.each([
    ['income_statement', () => m.incomeReport],
    ['balance_sheet', () => m.balanceReport],
    ['cash_flow', () => m.cashFlow],
    ['debtors_ageing', () => m.arAging],
    ['creditors_ageing', () => m.apAging],
    ['bank_reconciliation', () => m.recs],
  ] as const)('review off, %s refused: held as a draft, not delivered, and logged', async (section, mock) => {
    mock().mockRejectedValue(new MissingSystemAccountError('retained_earnings', 'co', 'no_claimant', []));
    const r = await run(['income_statement', 'balance_sheet', 'cash_flow', 'debtors_ageing', 'creditors_ageing', 'bank_reconciliation']);
    expect(r).toMatchObject({ status: 'draft', deliveryScheduled: false });
    expect(m.deliver).not.toHaveBeenCalled();
    expect(statusWritten()).toBe('draft');
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringContaining('held for review'), expect.objectContaining({ sections: [expect.any(String)] }), 'managementPackGeneratorService');
    void section;
  });

  it('a refused income statement holds the pack even when only the executive summary asked for it', async () => {
    m.incomeReport.mockRejectedValue(new MissingSystemAccountError('retained_earnings', 'co', 'no_claimant', []));
    const r = await run(['ai_executive_summary']);
    expect(r.status).toBe('draft');
    expect(m.deliver).not.toHaveBeenCalled();
  });

  it('a section that is off cannot hold the pack, and a budget refusal is not a failed read', async () => {
    m.arAging.mockRejectedValue(new Error('boom'));
    m.buildReport.mockRejectedValue(new TrackingError(409, 'no budget for this month'));
    const r = await run(['income_statement', 'income_vs_budget']);
    expect(r.status).toBe('signed_off');
  });

  it('a budget-engine FAULT holds the pack for review; a refusal (no budget, out of window) does not', async () => {
    m.buildReport.mockRejectedValue(new Error('relation "budget_month_amounts" does not exist'));
    const faulted = await run(['income_statement', 'income_vs_budget']);
    expect(faulted).toMatchObject({ status: 'draft', deliveryScheduled: false });
    expect(m.deliver).not.toHaveBeenCalled();
    expect(m.log.warn).toHaveBeenCalledWith(expect.stringContaining('held for review'), expect.objectContaining({ sections: ['budget'] }), 'managementPackGeneratorService');

    m.deliver.mockClear();
    m.buildReport.mockRejectedValue(new TrackingError(409, 'FY2027 does not run on calendar months'));
    const refused = await run(['income_statement', 'income_vs_budget']);
    expect(refused).toMatchObject({ status: 'signed_off', deliveryScheduled: true });
    m.deliver.mockClear();
    m.buildReport.mockRejectedValue(new BudgetVersionError('NOT_FOUND', 'no version'));
    expect((await run(['income_statement', 'income_vs_budget'])).status).toBe('signed_off');
  });

  it('a clean budget, or no budget section, holds nothing', async () => {
    expect((await run(['income_statement', 'income_vs_budget'])).status).toBe('signed_off');
    expect((await run(['kpi_scorecard'])).status).toBe('signed_off');
  });
});
