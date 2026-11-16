/**
 * The management pack's cash flow forecast section (Hein 2026-11-16): the P6 three-way budget's month-end cash,
 * from the pack month to the year end, for the fiscal year's primary version. Flag off: the section prints as it
 * always did (no blocks, the viewers' "not yet available" sentence). No version: one sentence. A refusal: one
 * sentence; a fault: one sentence and the pack is held for review.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  hasFeature: vi.fn(),
  getThreeWay: vi.fn(),
  fiscalYearForDate: vi.fn(),
  withSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: m.withSavepoint }));
vi.mock('@/lib/logger', () => ({ log: m.log }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: m.hasFeature }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: m.getThreeWay }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: m.fiscalYearForDate }));
vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'month ended 2026-10-31' } }),
}));

import {
  FORECAST_UNAVAILABLE, forecastBlocks, forecastSnapshot, loadPackForecast, noVersionSentence,
} from '@/modules/accounting/services/afs/managementPackForecast';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { OpeningUnbalancedError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsDocument, AfsSection, BrandProfile, NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';
import { threeWayView } from './managementPackForecastFixtures';

/** formatMoney groups with a no-break space. */
const plain = (s: string): string => s.replace(/\u00A0|&nbsp;/g, ' ');
const load = () => loadPackForecast('co', '2026-10', '2026-10-31', '2026-11-16');

beforeEach(() => {
  vi.clearAllMocks();
  m.hasFeature.mockResolvedValue(true);
  m.fiscalYearForDate.mockResolvedValue({ fiscalYear: 2027 });
  m.getThreeWay.mockResolvedValue(threeWayView());
});

describe('loadPackForecast', () => {
  it('reads the primary version of the fiscal year holding the pack month end, on the generation date', async () => {
    const f = await load();
    expect(m.hasFeature).toHaveBeenCalledWith('co', 'budgets_three_way');
    expect(m.fiscalYearForDate).toHaveBeenCalledWith('co', '2026-10-31');
    expect(m.getThreeWay).toHaveBeenCalledWith('co', { fiscalYear: 2027 }, '2026-11-16');
    expect(f.kind).toBe('forecast');
    if (f.kind !== 'forecast') return;
    expect(f.figures.months.map((r) => r.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    expect(f.figures.months.map((r) => r.belowMinimum)).toEqual([false, true, true, true, false]);
    expect(f.figures.lowest).toEqual({ month: '2026-12', closingCash: 200_000 });
    expect(f.figures).toMatchObject({ versionId: 'v-1', versionName: 'Original 2027', asAt: '2026-02-28', minimumCash: 500_000, balanced: true });
  });

  it('the flag off: nothing is read beyond the flag', async () => {
    m.hasFeature.mockResolvedValue(false);
    expect(await load()).toEqual({ kind: 'off' });
    expect(m.getThreeWay).not.toHaveBeenCalled();
  });

  it('no primary version: says so for the year, not a fault', async () => {
    m.getThreeWay.mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'FY2027 has no primary budget version'));
    expect(await load()).toEqual({ kind: 'none', fiscalYear: 2027 });
    expect(m.log.error).not.toHaveBeenCalled();
  });

  it('an engine refusal (opening does not balance) is unavailable, not a fault', async () => {
    m.getThreeWay.mockRejectedValue(new OpeningUnbalancedError(12));
    expect(await load()).toEqual({ kind: 'unavailable', fault: false });
    expect(m.log.warn).toHaveBeenCalled();
    expect(m.log.error).not.toHaveBeenCalled();
  });

  it('any other error is a fault: logged as an error, and the read ran in a savepoint', async () => {
    m.getThreeWay.mockRejectedValue(new Error('connection reset'));
    expect(await load()).toEqual({ kind: 'unavailable', fault: true });
    expect(m.log.error).toHaveBeenCalled();
    expect(m.withSavepoint).toHaveBeenCalledWith('mgmt_pack_forecast', expect.any(Function));
  });
});

describe('forecastBlocks', () => {
  it('prints the version, the as-at, the month-end table, the lowest month and the warnings in words', async () => {
    const blocks = forecastBlocks(await load());
    const text = plain(JSON.stringify(blocks));
    expect(text).toContain('Original 2027');
    expect(text).toContain('28 February 2026');
    const table = blocks.find((b) => b.type === 'table') as NoteContentTable;
    expect(table.headers).toEqual(['Month', 'Closing cash', 'Minimum cash', 'Below minimum']);
    expect(table.rows[0]?.map(plain)).toEqual(['October 2026', 'R 6 000.00', 'R 5 000.00', 'No']);
    expect(table.rows[2]?.map(plain)).toEqual(['December 2026', 'R 2 000.00', 'R 5 000.00', 'Yes']);
    expect(text).toContain('The lowest month-end cash is R 2 000.00 in December 2026, below the minimum of R 5 000.00.');
    expect(text).toContain('Debtor days are at the 120-day limit');
  });

  it('an unbalanced budget says which months', async () => {
    m.getThreeWay.mockResolvedValue(threeWayView({ checks: { balanced: false, unbalancedMonths: ['2026-11'], openingCash: { difference: 0, accounts: [] } } } as never));
    expect(JSON.stringify(forecastBlocks(await load()))).toContain('The budget does not balance in November 2026.');
  });

  it('no version: the one sentence; unavailable: the fixed sentence; off: no blocks (the viewers print the old sentence)', () => {
    expect(forecastBlocks({ kind: 'none', fiscalYear: 2027 })).toEqual([{ type: 'paragraph', text: noVersionSentence(2027) }]);
    expect(noVersionSentence(2027)).toBe('FY2027 has no primary budget version, so there is no budgeted cash projection.');
    expect(forecastBlocks({ kind: 'unavailable', fault: true })).toEqual([{ type: 'paragraph', text: FORECAST_UNAVAILABLE }]);
    expect(forecastBlocks({ kind: 'off' })).toEqual([]);
  });
});

describe('forecastSnapshot', () => {
  it('freezes the figures with the pack; off stores what it always did', async () => {
    const snap = forecastSnapshot(await load());
    expect(snap).toMatchObject({ kind: 'forecast', versionId: 'v-1', fiscalYear: 2027, minimumCash: 500_000, lowest: { month: '2026-12', closingCash: 200_000 } });
    expect((snap.months as unknown[]).length).toBe(5);
    expect(snap.warningCodes).toEqual(['opening_excess_spread']);
    expect(forecastSnapshot({ kind: 'off' })).toEqual({});
    expect(forecastSnapshot({ kind: 'none', fiscalYear: 2027 })).toEqual({ kind: 'none', fiscalYear: 2027 });
  });
});

describe('the PDF html of the stored section', () => {
  it('prints the table and the sentences under the section title', async () => {
    const brand = { id: 'bp', companyId: 'co', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional', coverStyle: 'classic', reportFooterText: null, createdAt: new Date(), updatedAt: new Date() } as BrandProfile;
    const document = { id: 'd', companyId: 'co', fiscalYear: null, period: '2026-10', documentType: 'management_pack', reportingFramework: 'ifrs_smes', status: 'draft', version: 1 } as unknown as AfsDocument;
    const section = { id: 's', documentId: 'd', companyId: 'co', sectionType: 'cash_flow_forecast', sortOrder: 0, status: 'auto_generated', dataSnapshot: null, content: { title: 'Cash Flow Forecast', blocks: forecastBlocks(await load()) }, overrides: null, aiNarrative: null, aiNarrativeAccepted: false } as unknown as AfsSection;
    const html = plain(await renderAfsToHtml({ document, sections: [section], brandProfile: brand, companyName: 'Acme', registrationNumber: '1' } as AfsRenderContext));
    expect(html).toContain('Cash Flow Forecast');
    expect(html).toContain('December 2026');
    expect(html).toContain('R 2 000.00');
    expect(html).not.toContain('This section is not yet available');
  });
});
