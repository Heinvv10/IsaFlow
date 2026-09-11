/**
 * The DOCX export hard-coded "Annual Financial Statements" on the cover and in the file title,
 * for a management pack too. A pack gets the same title and period line as its PDF.
 *
 * An AFS DOCX must not change. A DOCX is a zip whose docProps/core.xml carries the render
 * time (dcterms:created / dcterms:modified), so the file's bytes differ on every render and
 * byte-equality is not stable. The golden is STRUCTURAL: the sha256 of word/document.xml (the
 * whole body, cover included) and of core.xml with only those two timestamps removed, taken from
 * the exporter before the pack title was added.
 */
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import type { AfsDocument, AfsSection } from '@/modules/accounting/services/afs/afsTypes';

const at = new Date('2026-01-01T00:00:00Z');
const doc = (documentType: AfsDocument['documentType'], period: string | null, fiscalYear: number | null) => ({
  id: 'doc', companyId: 'co', fiscalYear, period, documentType, reportingFramework: 'ifrs_smes', status: 'draft',
  version: 1, createdAt: at, updatedAt: at,
}) as AfsDocument;
const sections = [{
  id: 'sec', documentId: 'doc', sectionType: 'note_1', status: 'auto_generated', sortOrder: 1, overrides: null,
  content: { title: 'Trade Receivables', blocks: [{ type: 'paragraph', text: 'Trade receivables & other <items>.' },
    { type: 'table', headers: ['Description', '2026'], rows: [['Debtors', '1 200']] }] },
}] as unknown as AfsSection[];

async function parts(document: AfsDocument) {
  const zip = await JSZip.loadAsync(await renderToDocx(document, sections, 'Acme (Pty) Ltd'));
  const body = await zip.file('word/document.xml')!.async('string');
  const core = (await zip.file('docProps/core.xml')!.async('string'))
    .replace(/<dcterms:(created|modified)[^>]*>[^<]*<\/dcterms:\1>/g, '');
  return { body, core };
}
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the DOCX cover', () => {
  it('an AFS DOCX is structurally identical to the exporter before pack titles existed', async () => {
    const byYear = await parts(doc('afs', null, 2026)), byPeriod = await parts(doc('afs', '2026-02', null));
    expect(sha(byYear.body), 'the body is not deterministic').toBe(sha((await parts(doc('afs', null, 2026))).body));
    expect({ yearBody: sha(byYear.body), yearCore: sha(byYear.core), periodBody: sha(byPeriod.body), periodCore: sha(byPeriod.core) }).toEqual({
      yearBody: '4a32e5857fe4f3334b63b0008d6cce970cc611bd46566e0aaafed32ef64a5243',
      yearCore: '10e658ea11dae8f9560fd1b97edeac669b4dafdc0e53c53e932999f60e1486e1',
      periodBody: 'b422f8f375beb4861ff6f9d9271f7ac3aa51b408e0176b6cb00d5f3954467fbc',
      periodCore: 'b62a5227d1147c723c80239b1f109c55a2f8231a1ebe62f4e71e51ecdf15c485',
    });
  });

  it('a management pack DOCX is titled Management Accounts for its period', async () => {
    const { body, core } = await parts(doc('management_pack', '2026-06', null));
    expect(body).toContain('>Management Accounts<');
    expect(body).toContain('>For the period 2026-06<');
    expect(core).toContain('Acme (Pty) Ltd — Management Accounts');
    expect(body + core, 'a management pack is not annual financial statements').not.toContain('Annual Financial Statements');
  });
});
