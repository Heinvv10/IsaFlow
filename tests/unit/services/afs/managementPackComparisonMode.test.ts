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
vi.mock('@/modules/accounting/services/afs/packDeliveryService', () => ({ deliverPack: vi.fn() }));

import { AGGS, band, generateWith, line, report, table, texts } from './managementPackFixtures';
import { comparisonPlan, topVarianceLines } from '@/modules/accounting/services/afs/managementPackComparison';
import { TrackingError } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { buildExecutiveSummaryPrompt } from '@/modules/accounting/services/afs/packAiSummaryService';

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

describe('comparison_mode on the income statement section', () => {
  it('prior_month keeps today\'s section, reads no budget and hands the AI the prior month', async () => {
    const out = await generate('prior_month', ['income_statement']);
    expect(out.income_statement).toEqual({
      title: 'Income Statement',
      blocks: [{ type: 'paragraph', text: JSON.stringify(AGGS['2026-09-01']) }],
    });
    expect(m.buildReport).not.toHaveBeenCalled();
    expect(m.commentary.mock.calls[0]?.[0].priorData).toEqual(AGGS['2026-08-01']);
    expect(m.summary.mock.calls[0]?.[0]).toMatchObject({ priorRevenue: 1200, priorLabel: 'prior month' });
  });

  it('prior_year compares the same month a year earlier', async () => {
    const out = await generate('prior_year', ['income_statement']);
    expect(table(out.income_statement)).toEqual({
      type: 'table',
      headers: ['', 'This month', 'Same month last year', 'Change on last year'],
      rows: [
        ['Revenue', 'R 1 500.00', 'R 900.00', 'R 600.00'],
        ['Cost of sales', 'R 400.00', 'R 100.00', 'R 300.00'],
        ['Net profit', 'R 300.00', 'R 200.00', 'R 100.00'],
      ],
    });
    expect(m.commentary.mock.calls[0]?.[0].priorData).toEqual({ same_month_last_year: AGGS['2025-09-01'] });
    expect(m.summary.mock.calls[0]?.[0]).toMatchObject({ priorRevenue: 900, priorLabel: 'the same month last year' });
  });

  it('budget adds the band table to the section when income_vs_budget is off', async () => {
    const out = await generate('budget', ['income_statement']);
    expect(out.income_statement?.blocks[0]).toEqual({ type: 'paragraph', text: JSON.stringify(AGGS['2026-09-01']) });
    expect(table(out.income_statement).rows[0]).toEqual(['Turnover', 'R 1 500.00', 'R 1 000.00', 'R 500.00', '+50.0%', 'Favourable']);
  });

  it('budget does not print the band table twice when income_vs_budget is on', async () => {
    const out = await generate('budget', ['income_statement', 'income_vs_budget']);
    expect(out.income_statement?.blocks.filter((b) => b.type === 'table')).toEqual([]);
    expect(table(out.income_vs_budget).headers[0]).toBe('');
  });

  it('all_three adds the prior month, the prior year and the band table', async () => {
    const out = await generate('all_three', ['income_statement']);
    expect(table(out.income_statement).headers).toEqual(['', 'This month', 'Prior month', 'Same month last year', 'Change on last year']);
    expect(table(out.income_statement).rows[0]).toEqual(['Revenue', 'R 1 500.00', 'R 1 200.00', 'R 900.00', 'R 600.00']);
    expect(table(out.income_statement, 1).headers).toEqual(['', 'Actual', 'Budget', 'Var R', 'Var %', 'Position']);
    expect(m.commentary.mock.calls[0]?.[0].priorData).toEqual({ prior_month: AGGS['2026-08-01'], same_month_last_year: AGGS['2025-09-01'] });
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
