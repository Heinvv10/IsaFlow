import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import type { AfsDocument } from '@/modules/accounting/services/afs/afsTypes';

vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'year ended 2026-02-28' } }),
}));

async function documentXml(doc: Partial<AfsDocument>): Promise<string> {
  const buf = await renderToDocx({ id: 'd', companyId: 'c', ...doc } as AfsDocument, [], 'Acme');
  const zip = await JSZip.loadAsync(buf);
  return zip.file('word/document.xml')!.async('string');
}

describe('DOCX cover title', () => {
  it('management pack says Management Pack and the month', async () => {
    const xml = await documentXml({ documentType: 'management_pack', fiscalYear: null, period: '2026-10' });
    expect(xml).toContain('Management Pack');
    expect(xml).toContain('2026-10');
    expect(xml).not.toContain('Annual Financial Statements');
  });
  it('AFS unchanged', async () => {
    const xml = await documentXml({ documentType: 'afs', fiscalYear: 2026, period: null });
    expect(xml).toContain('Annual Financial Statements');
    expect(xml).not.toContain('Management Pack');
  });
});
