import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import type { AfsDocument } from '@/modules/accounting/services/afs/afsTypes';

vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'year ended 2026-02-28' } }),
}));

async function parts(doc: Partial<AfsDocument>): Promise<{ xml: string; core: string; paragraphs: string[] }> {
  const buf = await renderToDocx({ id: 'd', companyId: 'c', ...doc } as AfsDocument, [], 'Acme');
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')!.async('string');
  const core = await zip.file('docProps/core.xml')!.async('string');
  const paragraphs = [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gs)].map((m) =>
    [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''));
  return { xml, core, paragraphs };
}

describe('DOCX cover title', () => {
  it('management pack: cover paragraphs, file title and description name the pack and the month', async () => {
    const { paragraphs, core } = await parts({ documentType: 'management_pack', fiscalYear: null, period: '2026-10' });
    expect(paragraphs.slice(0, 12)).toEqual(expect.arrayContaining(['Acme', 'Management Pack', 'For the month of October 2026']));
    expect(core).toContain('Acme — Management Pack');
    expect(core).toContain('Management pack for October 2026');
    expect(paragraphs).not.toContain('Annual Financial Statements');
    expect(core).not.toContain('Annual Financial Statements');
    expect(core).not.toContain('AFS for');
  });
  it('AFS unchanged', async () => {
    const { paragraphs, core } = await parts({ documentType: 'afs', fiscalYear: 2026, period: null });
    expect(paragraphs).toEqual(expect.arrayContaining(['Annual Financial Statements', 'For the year ended 2026-02-28']));
    expect(core).toContain('Acme — Annual Financial Statements');
    expect(core).toContain('AFS for fiscal year 2026');
    expect(paragraphs).not.toContain('Management Pack');
  });
  it.each([[null], [''], ['2026-13']])('pack with period %j: description is just "Management pack", cover has no period line', async (period) => {
    const { paragraphs, core } = await parts({ documentType: 'management_pack', fiscalYear: null, period });
    expect(core).toContain('<dc:description>Management pack</dc:description>');
    expect(paragraphs.some((t) => t.startsWith('For the'))).toBe(false);
    expect(paragraphs).toContain('Management Pack');
  });
});
