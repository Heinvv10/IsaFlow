/**
 * The generator stores the cash flow forecast section's blocks and its snapshot with the pack (frozen: the
 * viewers print the stored content, nothing recomputes it), prints it as before when the flag is off, and holds
 * a pack whose forecast read faulted for review instead of signing it off and sending it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(),
  createSection: vi.fn(),
  updateSection: vi.fn(),
  deliverPack: vi.fn(),
  hasFeature: vi.fn(),
  getThreeWay: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: m.withSavepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: m.hasFeature }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: m.getThreeWay }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: vi.fn(async () => ({ fiscalYear: 2027 })) }));
vi.mock('@/modules/accounting/services/afs/afsDocumentService', () => ({ createAfsDocument: vi.fn(async () => ({ id: 'doc-1' })) }));
vi.mock('@/modules/accounting/services/afs/afsSectionService', () => ({ createAfsSection: m.createSection, updateAfsSection: m.updateSection }));
vi.mock('@/modules/accounting/services/afs/afsKpiService', () => ({ getKpiScorecard: vi.fn(async () => ({ kpis: [] })) }));
vi.mock('@/modules/accounting/services/afs/packAiSummaryService', () => ({
  generateExecutiveSummary: vi.fn(async () => 'summary'),
  generateSectionCommentary: vi.fn(async () => 'commentary'),
}));
vi.mock('@/modules/accounting/services/afs/packDeliveryService', () => ({ deliverPack: m.deliverPack }));

import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';
import { generateSectionCommentary } from '@/modules/accounting/services/afs/packAiSummaryService';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';
import { config } from './managementPackFixtures';
import { threeWayView } from './managementPackForecastFixtures';

type Patch = { content?: NoteContent; dataSnapshot?: Record<string, unknown> };

async function generate(reviewRequired = true): Promise<{ status: string; patch: Patch }> {
  const cfg = { ...config('prior_month', ['cash_flow_forecast']), reviewRequired };
  const result = await generateManagementPack({ companyId: 'co', period: '2026-10', config: cfg, triggeredBy: 'cron' });
  const call = (m.updateSection.mock.calls as [string, string, string, Patch][]).find(([id, , , p]) => id === 'cash_flow_forecast' && p.content);
  return { status: result.status, patch: (call?.[3] ?? {}) as Patch };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.sql.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('?').includes('SELECT id FROM afs_documents') ? [] : [{}]);
  m.createSection.mockImplementation(async ({ sectionType }: { sectionType: string }) => ({ id: sectionType, sectionType }));
  m.updateSection.mockResolvedValue(undefined);
  m.hasFeature.mockResolvedValue(true);
  m.getThreeWay.mockResolvedValue(threeWayView());
});

describe('generator: cash flow forecast section', () => {
  it('stores the forecast table and its frozen figures; no AI commentary is asked for it', async () => {
    const { patch } = await generate();
    expect(patch.content?.title).toBe('Cash Flow Forecast');
    expect(patch.content?.blocks.some((b) => b.type === 'table')).toBe(true);
    expect(patch.dataSnapshot).toMatchObject({ kind: 'forecast', versionId: 'v-1', minimumCash: 500_000 });
    expect(generateSectionCommentary).not.toHaveBeenCalled();
  });

  it('the flag off: the section is stored exactly as before (no blocks, empty snapshot)', async () => {
    m.hasFeature.mockResolvedValue(false);
    const { patch } = await generate();
    expect(patch.content).toEqual({ title: 'Cash Flow Forecast', blocks: [] });
    expect(patch.dataSnapshot).toEqual({});
    expect(m.getThreeWay).not.toHaveBeenCalled();
  });

  it('not enabled: the forecast is not read at all', async () => {
    await generateManagementPack({ companyId: 'co', period: '2026-10', config: config('prior_month', ['kpi_scorecard']), triggeredBy: 'cron' });
    expect(m.hasFeature).not.toHaveBeenCalled();
    expect(m.getThreeWay).not.toHaveBeenCalled();
  });

  it('a faulted forecast read holds a review-free pack as a draft and does not send it', async () => {
    m.getThreeWay.mockRejectedValue(new Error('connection reset'));
    const { status } = await generate(false);
    expect(status).toBe('draft');
    expect(m.deliverPack).not.toHaveBeenCalled();
  });

  it('a review-free pack with a forecast is signed off and sent as before', async () => {
    const { status } = await generate(false);
    expect(status).toBe('signed_off');
    expect(m.deliverPack).toHaveBeenCalledTimes(1);
  });
});
