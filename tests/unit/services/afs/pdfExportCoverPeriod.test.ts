/**
 * The PDF cover's period wording comes from findReportingPeriod: a document whose
 * label no year carries keeps the renderer's year-end wording, a transition year
 * says "14 months ended", and any other failure stops the export instead of
 * printing a wrong period.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/safeFetch', () => ({ checkPublicUrl: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/afs/brandProfileService', () => ({
  getBrandProfile: vi.fn(async () => ({ logoUrl: null })),
}));
vi.mock('@/modules/accounting/services/afs/afsPreExportChecks', () => ({ runPreExportChecks: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/afs/afsHtmlRendererService', () => ({ renderAfsToHtml: vi.fn(() => '<html></html>') }));
vi.mock('@/modules/accounting/services/afs/serverChartSvg', () => ({ buildAfsCharts: vi.fn(() => []) }));
vi.mock('@/modules/accounting/services/afs/weasyprintService', () => ({ htmlToPdf: vi.fn(async () => Buffer.from('%PDF')) }));
vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({ findReportingPeriod: vi.fn() }));

import { sql } from '@/lib/neon';
import { findReportingPeriod } from '@/modules/accounting/services/afs/afsReportingPeriod';
import { renderAfsToHtml } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import { exportToPdf } from '@/modules/accounting/services/afs/pdfExportService';

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const find = findReportingPeriod as unknown as ReturnType<typeof vi.fn>;
const render = renderAfsToHtml as unknown as ReturnType<typeof vi.fn>;
const CO = 'c0000000-0000-0000-0000-000000000001';

function stubRows(fiscalYear: number | null): void {
  sqlMock
    .mockResolvedValueOnce([{ id: 'd1', company_id: CO, fiscal_year: fiscalYear, document_type: 'afs', reporting_framework: 'ifrs_smes', status: 'draft', version: 1 }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ name: 'Synthetic', registration_number: '' }]);
}

describe('exportToPdf cover period', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the transition year phrase to the renderer', async () => {
    stubRows(2026);
    find.mockResolvedValueOnce({ current: { phrase: '14 months ended 2027-02-28' } });
    await exportToPdf('d1', CO, { skipChecks: true });
    expect(find).toHaveBeenCalledWith(CO, 2026, 'pdfExportService');
    expect(render.mock.calls[0]![0].periodPhrase).toBe('14 months ended 2027-02-28');
  });

  it('a label no year carries leaves the phrase to the renderer', async () => {
    stubRows(2027);
    find.mockResolvedValueOnce(null);
    await exportToPdf('d1', CO, { skipChecks: true });
    expect(render.mock.calls[0]![0].periodPhrase).toBeUndefined();
  });

  it('a document with no fiscal year does not look a period up', async () => {
    stubRows(null);
    await exportToPdf('d1', CO, { skipChecks: true });
    expect(find).not.toHaveBeenCalled();
    expect(render.mock.calls[0]![0].periodPhrase).toBeUndefined();
  });

  it('any other failure stops the export', async () => {
    stubRows(2026);
    find.mockRejectedValueOnce(new Error('assumed start month'));
    await expect(exportToPdf('d1', CO, { skipChecks: true })).rejects.toThrow('assumed start month');
    expect(render).not.toHaveBeenCalled();
  });
});
