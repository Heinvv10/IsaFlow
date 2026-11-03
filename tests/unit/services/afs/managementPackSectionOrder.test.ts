/**
 * Pack sections print in one canonical order, not in the stored jsonb's key order
 * (Hein 2026-11-03: Income Statement before Budget Variance).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  buildReport: vi.fn(),
  createSection: vi.fn(),
  updateSection: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: m.withSavepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/tracking/budgetTrackingService', () => ({ buildBudgetTrackingReport: m.buildReport }));
vi.mock('@/modules/accounting/services/afs/afsDocumentService', () => ({ createAfsDocument: vi.fn(async () => ({ id: 'doc-1' })) }));
vi.mock('@/modules/accounting/services/afs/afsSectionService', () => ({ createAfsSection: m.createSection, updateAfsSection: m.updateSection }));
vi.mock('@/modules/accounting/services/afs/afsKpiService', () => ({
  fetchBalanceSnapshot: vi.fn(async () => ({})),
  getKpiScorecard: vi.fn(async () => ({ kpis: [] })),
}));
vi.mock('@/modules/accounting/services/afs/packAiSummaryService', () => ({
  generateExecutiveSummary: vi.fn(async () => 'summary'),
  generateSectionCommentary: vi.fn(async () => 'commentary'),
}));
vi.mock('@/modules/accounting/services/afs/packDeliveryService', () => ({ deliverPack: vi.fn() }));

import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import { orderedEnabledSections } from '@/modules/accounting/services/afs/managementPackConfigService';
import { config, report } from './managementPackFixtures';

const CANONICAL = ['income_statement', 'income_vs_budget', 'balance_sheet', 'budget_variance', 'cash_flow_forecast'];

async function printed(keys: string[]): Promise<{ type: string; sortOrder: number }[]> {
  await generateManagementPack({ companyId: 'co', period: '2026-08', config: config('prior_month', keys), triggeredBy: 'manual' });
  return (m.createSection.mock.calls as [{ sectionType: string; sortOrder: number }][])
    .map(([c]) => ({ type: c.sectionType, sortOrder: c.sortOrder }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('?').includes('SELECT id FROM afs_documents') ? [] : [{}]);
  m.createSection.mockImplementation(async ({ sectionType }: { sectionType: string }) => ({ id: sectionType, sectionType }));
  m.updateSection.mockResolvedValue(undefined);
  m.buildReport.mockResolvedValue(report());
});

describe('pack section order', () => {
  it('budget_variance stored first still prints after income_statement', async () => {
    const out = await printed(['budget_variance', 'cash_flow_forecast', 'balance_sheet', 'income_vs_budget', 'income_statement']);
    expect(out.map((s) => s.type)).toEqual(CANONICAL);
    expect(out.map((s) => s.sortOrder)).toEqual([0, 1, 2, 3, 4]);
  });

  it('a shuffled key order gives the same print order', async () => {
    const out = await printed(['income_vs_budget', 'cash_flow_forecast', 'income_statement', 'budget_variance', 'balance_sheet']);
    expect(out.map((s) => s.type)).toEqual(CANONICAL);
  });

  it('unknown keys go last in stored order; disabled keys drop out', () => {
    expect(orderedEnabledSections({ zeta: true, budget_variance: true, alpha: true, cover: false, income_statement: true }))
      .toEqual(['income_statement', 'budget_variance', 'zeta', 'alpha']);
  });
});
