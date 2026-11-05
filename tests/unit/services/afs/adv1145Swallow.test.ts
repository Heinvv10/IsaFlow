/**
 * Adversarial repro for PR #1145 (harness copied from managementPackComparisonMode.test.ts).
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

import { AGGS, balanceReportFor, generateWith, incomeReportFor, report } from "./managementPackFixtures";





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
  m.withSavepoint.mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn());
});

describe('F5 a programming fault in a statement read is swallowed into the client-facing pack', () => {
  it('a TypeError from getBalanceSheet (not a refusal) reaches Bugsink, as the budget path does for a fault', async () => {
    process.env.SENTRY_ENABLED = 'true';
    m.balanceReport.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'balance')"));
    const sections = await generate('prior_month', ['income_statement', 'balance_sheet']);
    // The pack generated, the balance sheet says it could not be produced...
    expect(sections.balance_sheet?.blocks).toEqual([{ type: 'paragraph', text: 'This statement could not be produced for this period.' }]);
    // ...and nobody but the log is told.
    expect(m.capture).toHaveBeenCalled();
  });
});

describe('F6 an income statement that could not be produced still gets AI commentary on figures it does not print', () => {
  it('no narrative is stored for income_statement when its report failed (balance_sheet is guarded the same way)', async () => {
    m.incomeReport.mockRejectedValue(new Error('statement read failed'));
    const sections = await generate('prior_month', ['income_statement', 'balance_sheet']);
    expect(sections.income_statement?.blocks).toEqual([{ type: 'paragraph', text: 'This statement could not be produced for this period.' }]);
    const narrated = m.updateSection.mock.calls.filter(([id, , , patch]) => id === 'income_statement' && patch?.aiNarrative);
    expect(narrated).toEqual([]);
  });
});
