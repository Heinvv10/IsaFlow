/**
 * A management pack's sections in the PDF's HTML and in the DOCX: titled from the section vocabulary,
 * never a bare key, never a bare heading, statements as tables with styled subtotal rows, the AI
 * narrative printed, and no recto page break per section (it left a blank page between sections).
 * AFS documents keep their own section layout.
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import type { AfsDocument, AfsSection, BrandProfile, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'year ended 2026-02-28' } }),
}));

const brand = {
  id: 'bp', companyId: 'co', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional',
  coverStyle: 'classic', reportFooterText: null, createdAt: new Date(), updatedAt: new Date(),
} as BrandProfile;
const PACK = { id: 'd', companyId: 'co', fiscalYear: null, period: '2026-10', documentType: 'management_pack', reportingFramework: 'ifrs_smes', status: 'draft', version: 1 } as unknown as AfsDocument;
const AFS = { ...PACK, documentType: 'afs', fiscalYear: 2026, period: null } as unknown as AfsDocument;

const section = (sectionType: string, title: string, blocks: NoteContentBlock[], aiNarrative: string | null = null, sortOrder = 0): AfsSection => ({
  id: `id-${sectionType}`, documentId: 'd', companyId: 'co', sectionType, sortOrder, status: 'ai_enhanced', dataSnapshot: null,
  content: { title, blocks }, overrides: null, aiNarrative, aiNarrativeAccepted: false,
} as unknown as AfsSection);
const html = (document: AfsDocument, sections: AfsSection[]) =>
  renderAfsToHtml({ document, sections, brandProfile: brand, companyName: 'Acme', registrationNumber: '1' } as AfsRenderContext);
const headings = (h: string) => [...h.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1]);

const STATEMENT: NoteContentBlock = {
  type: 'table', headers: ['', 'This month'],
  rows: [['Revenue', ''], ['4100 Sales', 'R 10.00'], ['Total revenue', 'R 10.00'], ['Net profit', 'R 4.00']],
  rowKinds: ['heading', 'line', 'subtotal', 'total'],
};

describe('PDF html of a management pack', () => {
  const sections = [
    section('cover', 'cover', [], 'commentary on a cover'),
    section('ai_executive_summary', 'ai_executive_summary', [], 'The month was quiet.', 1),
    section('income_statement', 'Income Statement', [STATEMENT], 'Sales were flat.', 2),
    section('cash_flow', 'cash_flow', [], null, 3),
  ];
  const out = html(PACK, sections);

  it('titles every section from the vocabulary and prints no bare key as a heading', () => {
    expect(headings(out)).toEqual(['AI Executive Summary', 'Income Statement', 'Cash Flow']);
    expect(out).not.toMatch(/<h2[^>]*>(cover|ai_executive_summary|cash_flow)<\/h2>/);
  });

  it('leaves the cover section out: the pack has its own cover page', () => {
    expect(out).not.toContain('commentary on a cover');
  });

  it('prints the AI narrative, and a sentence for a section with nothing', () => {
    expect(out).toContain('<p class="ai-narrative">The month was quiet.</p>');
    expect(out).toContain('<p class="ai-narrative">Sales were flat.</p>');
    expect(out).toContain('This section is not yet available in the management pack.');
  });

  it('styles statement rows by kind', () => {
    expect(out).toContain('<tr class="row-heading">');
    expect(out).toContain('<tr class="row-subtotal">');
    expect(out).toContain('<tr class="row-total">');
    expect(out).toMatch(/<tr><td>4100 Sales<\/td>/);
  });

  it('breaks no page to the recto per section, and starts each statement on a page of its own', () => {
    expect(out).not.toContain('class="section-start"');
    expect(out).toContain('class="pack-section pack-statement"');
    expect(out).toMatch(/\.pack-statement \{ break-before: page;/);
  });

  it('a section with no content prints a sentence, never a bare heading', () => {
    const only = html(PACK, [section('debtors_ageing', 'debtors_ageing', [])]);
    expect(only).toMatch(/<h2>Debtors Ageing<\/h2>\s*<p>This section is not yet available/);
  });

  it('a failed AI call\'s sentence is not printed as commentary', () => {
    const o = html(PACK, [section('kpi_scorecard', 'KPI Scorecard', [STATEMENT], 'AI commentary unavailable for this section.')]);
    expect(o).not.toContain('AI commentary unavailable');
    expect(o).not.toContain('ai-narrative">');
  });

  it('an older pack\'s JSON balance sheet prints as a table, not as text', () => {
    const o = html(PACK, [section('balance_sheet', 'Balance Sheet', [{ type: 'paragraph', text: '{"currentAssets":44600,"totalEquity":44600}' }])]);
    expect(o).not.toContain('currentAssets');
    expect(o).toContain('<td>Current assets</td>');
  });

  it('escapes what it prints', () => {
    const o = html(PACK, [section('kpi_scorecard', 'KPI Scorecard', [{ type: 'paragraph', text: '<script>x</script>' }], '<b>n</b>')]);
    expect(o).not.toContain('<script>');
    expect(o).toContain('&lt;b&gt;n&lt;/b&gt;');
  });
});

describe('an AFS document is unchanged', () => {
  it('keeps the section-start layout and its stored titles', () => {
    const o = html(AFS, [section('income_statement', 'Statement of Profit or Loss', [{ type: 'paragraph', text: 'x' }])]);
    expect(o).toContain('class="section-start"');
    expect(headings(o)).toEqual(['Statement of Profit or Loss']);
    expect(o).not.toContain('pack-section"');
  });
});

describe('DOCX of a management pack', () => {
  async function paragraphs(document: AfsDocument, sections: AfsSection[]): Promise<string[]> {
    const zip = await JSZip.loadAsync(await renderToDocx(document, sections, 'Acme'));
    const xml = await zip.file('word/document.xml')!.async('string');
    return [...xml.matchAll(/<w:p[ >].*?<\/w:p>/gs)].map((m) => [...m[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''));
  }

  it('titles from the vocabulary, a sentence for an empty section, the narrative, no cover section', async () => {
    const p = await paragraphs(PACK, [
      section('cover', 'cover', []),
      section('ai_executive_summary', 'ai_executive_summary', [], 'The month was quiet.', 1),
      section('cash_flow', 'cash_flow', [], null, 2),
    ]);
    expect(p).toEqual(expect.arrayContaining(['AI Executive Summary', 'The month was quiet.', 'Cash Flow', 'This section is not yet available in the management pack.']));
    expect(p).not.toContain('cash_flow');
    expect(p).not.toContain('ai_executive_summary');
    expect(p).not.toContain('cover');
  });
});
