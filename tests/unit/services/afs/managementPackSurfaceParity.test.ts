/**
 * Every pack surface prints the same sections in the same order, from the same content: canonical print order
 * for packs stored with a scrambled sort_order (the 2026-10 pack of QA Budgets P3 was written before the
 * generator followed it), overrides over content, and no stored shape crashes any of them.
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import { packSectionViews } from '@/modules/accounting/services/afs/managementPackSectionView';
import { orderPackSections } from '@/modules/accounting/services/afs/managementPackSections';
import type { AfsDocument, AfsSection, BrandProfile, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'year ended 2026-02-28' } }),
}));

const brand = { id: 'b', companyId: 'c', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional', coverStyle: 'classic', reportFooterText: null, createdAt: new Date(), updatedAt: new Date() } as BrandProfile;
const PACK = { id: 'd', companyId: 'c', fiscalYear: null, period: '2026-10', documentType: 'management_pack', reportingFramework: 'ifrs_smes', status: 'draft', version: 1 } as unknown as AfsDocument;
const sec = (sectionType: string, sortOrder: number, extra: Record<string, unknown> = {}): AfsSection => ({
  id: `id-${sectionType}`, documentId: 'd', companyId: 'c', sectionType, sortOrder, status: 'ai_enhanced', dataSnapshot: null,
  content: { title: sectionType, blocks: [{ type: 'paragraph', text: `body of ${sectionType}` }] }, overrides: null, aiNarrative: null, aiNarrativeAccepted: false, ...extra,
} as unknown as AfsSection);

/** The stored sort_order of the 2026-10 pack: cover first, then the order the old generator's Promise.all happened to write. */
const STORED_OCT = ['cover', 'cash_flow', 'balance_sheet', 'kpi_scorecard', 'debtors_ageing', 'budget_variance', 'creditors_ageing', 'income_statement', 'income_vs_budget', 'bank_reconciliation', 'ai_executive_summary'];
const CANONICAL_OCT = ['ai_executive_summary', 'kpi_scorecard', 'income_statement', 'income_vs_budget', 'balance_sheet', 'cash_flow', 'debtors_ageing', 'creditors_ageing', 'bank_reconciliation', 'budget_variance'];
const scrambled = STORED_OCT.map((k, i) => sec(k, i));

describe('print order', () => {
  it('orderPackSections puts a scrambled pack in canonical order, an unknown key last in its stored order', () => {
    expect(orderPackSections(scrambled).map((s) => s.sectionType)).toEqual(['cover', ...CANONICAL_OCT]);
    const withUnknown = [sec('zzz_new', 1), sec('kpi_scorecard', 5), sec('aaa_new', 0)];
    expect(orderPackSections(withUnknown).map((s) => s.sectionType)).toEqual(['kpi_scorecard', 'aaa_new', 'zzz_new']);
  });

  it('packSectionViews: canonical, cover dropped', () => {
    expect(packSectionViews(scrambled).map(({ section }) => section.sectionType)).toEqual(CANONICAL_OCT);
  });

  it('the PDF prints that order', () => {
    const html = renderAfsToHtml({ document: PACK, sections: scrambled, brandProfile: brand, companyName: 'Acme', registrationNumber: '1' } as AfsRenderContext);
    const ids = [...html.matchAll(/<section class="pack-section[^"]*" id="section-id-([a-z_]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(CANONICAL_OCT);
  });

  it('the DOCX prints that order', async () => {
    const zip = await JSZip.loadAsync(await renderToDocx(PACK, scrambled, 'Acme'));
    const xml = await zip.file('word/document.xml')!.async('string');
    const bodies = [...xml.matchAll(/body of ([a-z_]+)/g)].map((m) => m[1]);
    expect(bodies).toEqual(CANONICAL_OCT);
  });
});

describe('stored shapes the surfaces must survive (older rows; the route now refuses them)', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['a numeric title', { title: 123, blocks: [{ type: 'paragraph', text: 'ok' }] }],
    ['an object title', { title: { en: 'x' }, blocks: [{ type: 'paragraph', text: 'ok' }] }],
    ['a null block', { blocks: [null, { type: 'paragraph', text: 'ok' }] }],
    ['a numeric cell', { blocks: [{ type: 'table', headers: ['A', 'B'], rows: [['x', 42]] }] }],
    ['blocks that is a string', { blocks: 'nope' }],
  ];
  it.each(bad)('%s: PDF, DOCX and the view all print', async (_n, overrides) => {
    const s = sec('kpi_scorecard', 0, { overrides });
    const html = renderAfsToHtml({ document: PACK, sections: [s], brandProfile: brand, companyName: 'Acme', registrationNumber: '1' } as AfsRenderContext);
    expect(html).toMatch(/<h2>KPI Scorecard<\/h2>/);
    expect((await renderToDocx(PACK, [s], 'Acme')).length).toBeGreaterThan(1000);
    expect(packSectionViews([s])[0]?.view.title).toBe('KPI Scorecard');
  });

  it('a numeric cell prints as its text on every surface', () => {
    const blocks = [{ type: 'table', headers: ['A', 'B'], rows: [['x', 42]] }] as unknown as NoteContentBlock[];
    const view = packSectionViews([sec('kpi_scorecard', 0, { overrides: { blocks } })])[0]?.view;
    expect(view?.blocks[0]).toMatchObject({ rows: [['x', '42']] });
  });
});
