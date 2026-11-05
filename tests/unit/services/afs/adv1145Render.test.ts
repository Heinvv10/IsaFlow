/**
 * Adversarial repros for PR #1145 (pack section rendering): PDF HTML and DOCX.
 * Every `it` here asserts the CORRECT behaviour, so a red run is the finding.
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import { renderSectionContent } from '@/modules/accounting/services/afs/afsHtmlTableRenderer';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import { sectionOverridesSchema } from '@/modules/accounting/services/afs/sectionOverridesSchema';
import type { AfsDocument, AfsSection, BrandProfile, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'year ended 2026-02-28' } }),
}));

const brand = {
  id: 'bp', companyId: 'co', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional',
  coverStyle: 'classic', reportFooterText: null, createdAt: new Date(), updatedAt: new Date(),
} as BrandProfile;
const PACK = { id: 'd', companyId: 'co', fiscalYear: null, period: '2026-10', documentType: 'management_pack', reportingFramework: 'ifrs_smes', status: 'draft', version: 1 } as unknown as AfsDocument;

const section = (sectionType: string, blocks: NoteContentBlock[], overrides: unknown = null): AfsSection => ({
  id: `id-${sectionType}`, documentId: 'd', companyId: 'co', sectionType, sortOrder: 0, status: 'ai_enhanced', dataSnapshot: null,
  content: { title: sectionType, blocks }, overrides, aiNarrative: null, aiNarrativeAccepted: false,
} as unknown as AfsSection);
const pdf = (sections: AfsSection[]) =>
  renderAfsToHtml({ document: PACK, sections, brandProfile: brand, companyName: 'Acme', registrationNumber: '1' } as AfsRenderContext);

const STATEMENT: NoteContentBlock = {
  type: 'table', headers: ['', 'This month', 'Prior month'],
  rows: [['Revenue', '', ''], ['4100 Sales', 'R 250 000.00', 'R 120 000.00'], ['Net profit', 'R 250 150.00', 'R 44 600.00']],
  rowKinds: ['heading', 'line', 'total'],
};

describe('F1 override shapes the overrides route accepts crash the PDF export', () => {
  it('the route now refuses these overrides (they were accepted before the schema)', () => {
    expect(sectionOverridesSchema.safeParse({ title: 123 }).success).toBe(false);
    expect(sectionOverridesSchema.safeParse({ blocks: [null] }).success).toBe(false);
    expect(sectionOverridesSchema.safeParse({ blocks: [{ type: 'table', headers: ['A', 'B'], rows: [['x', 42]] }] }).success).toBe(true);
  });

  it('a numeric overrides.title (no blocks) renders: before this PR the pack PDF ignored a title without blocks', () => {
    const s = section('income_statement', [STATEMENT], { title: 123 });
    expect(() => renderSectionContent(s)).not.toThrow(); // the pre-PR pack path: fine
    expect(() => pdf([s])).not.toThrow(); // the new path
  });

  it('a null block in overrides.blocks renders', () => {
    expect(() => pdf([section('kpi_scorecard', [], { blocks: [null] })])).not.toThrow();
  });

  it('a numeric table cell prints in the PDF as it does in the in-app viewer (String(cell))', () => {
    expect(() => pdf([section('kpi_scorecard', [], { blocks: [{ type: 'table', headers: ['A', 'B'], rows: [['x', 42]] }] })])).not.toThrow();
  });
});

describe('F4 DOCX drops the statement row kinds the PDF, viewer and portal print', () => {
  it('the bottom line (rowKinds total) is bold in the DOCX', async () => {
    const buf = await renderToDocx(PACK, [section('income_statement', [STATEMENT])], 'Acme');
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
    const row = xml.split('<w:tr>').find((r) => r.includes('Net profit')) ?? '';
    expect(row).not.toBe('');
    expect(row).toContain('<w:b/>');
  });

  it('every figure column of a statement is right-aligned in the DOCX', async () => {
    const buf = await renderToDocx(PACK, [section('income_statement', [STATEMENT])], 'Acme');
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
    const row = xml.split('<w:tr>').find((r) => r.includes('4100 Sales')) ?? '';
    const cells = row.split('<w:tc>').slice(1);
    // cell 1 = "This month", cell 2 = "Prior month"
    expect(cells[1]).toContain('w:jc w:val="right"');
    expect(cells[2]).toContain('w:jc w:val="right"');
  });
});

describe('held: markup in every stored field is escaped in the PDF HTML', () => {
  it('title, narrative, cells, headers, rowKinds, list items, headings, section id, company name', () => {
    const X = '<img src=x onerror=alert(1)><link rel=stylesheet href="http://169.254.169.254/x">';
    const s = {
      id: `"><script>${X}`, documentId: 'd', companyId: 'co', sectionType: `kpi_scorecard`, sortOrder: 0, status: 'x', dataSnapshot: null,
      content: { title: X, blocks: [
        { type: 'paragraph', text: X }, { type: 'heading', text: X, level: `2"><script>` }, { type: 'list', items: [X] },
        { type: 'table', headers: [X], rows: [[X]], rowKinds: [`total"><script>`] },
      ] },
      overrides: { title: X }, aiNarrative: X, aiNarrativeAccepted: false,
    } as unknown as AfsSection;
    const h = renderAfsToHtml({ document: PACK, sections: [s], brandProfile: brand, companyName: X, registrationNumber: X } as AfsRenderContext);
    expect(h).not.toMatch(/<img|<link|<script/i);
  });
});
