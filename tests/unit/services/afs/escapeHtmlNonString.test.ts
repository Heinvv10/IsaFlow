/**
 * Section content is free-form JSON (a tenant writes `overrides`), so a cell, title or list item that is
 * not a string must be printed as text, never crash the whole export.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({
  findReportingPeriod: vi.fn().mockResolvedValue({ current: { phrase: 'year ended 2026-02-28' } }),
}));
import { escapeHtml } from '@/modules/accounting/services/afs/afsHtmlTableRenderer';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsDocument, AfsSection, BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

const brand = { id: 'b', companyId: 'c', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional', coverStyle: 'classic', reportFooterText: null, createdAt: new Date(), updatedAt: new Date() } as BrandProfile;
const doc = (documentType: string) => ({ id: 'd', companyId: 'c', fiscalYear: documentType === 'afs' ? 2026 : null, period: documentType === 'afs' ? null : '2026-10', documentType, reportingFramework: 'ifrs_smes', status: 'draft', version: 1 }) as unknown as AfsDocument;
const render = (documentType: string, overrides: unknown): string => renderAfsToHtml({
  document: doc(documentType), brandProfile: brand, companyName: 'Acme', registrationNumber: '1',
  sections: [{ id: 's', sectionType: 'kpi_scorecard', sortOrder: 0, aiNarrative: null, content: { title: 'KPI Scorecard', blocks: [] }, overrides } as unknown as AfsSection],
} as AfsRenderContext);

describe('escapeHtml', () => {
  it('escapes markup, and prints null and undefined as nothing and any other value as its text', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
    expect(escapeHtml({ v: 1 })).toBe('[object Object]');
    expect(escapeHtml(['<b>'])).toBe('&lt;b&gt;');
  });
});

describe('an override with non-string content does not crash either document type', () => {
  const overrides = {
    title: 7,
    blocks: [
      { type: 'paragraph', text: null },
      { type: 'table', headers: ['A', 5], rows: [['x', 42], ['y', null], ['z', { v: 1 }], 'not-a-row'], rowKinds: ['total'] },
      { type: 'list', items: [1, null, '<i>'] },
      { type: 'table', headers: 'nope', rows: 'nope' },
      { type: 'list', items: 'nope' },
    ],
  };
  it.each(['management_pack', 'afs'])('%s', (type) => {
    const html = render(type, overrides);
    expect(html).toContain('<td>42</td>');
    expect(html).toContain('<th>5</th>');
    expect(html).toContain('<li>1</li>');
    expect(html).toContain('<li>&lt;i&gt;</li>');
    expect(html).not.toContain('<i>');
    expect(html).toMatch(/<h2>7<\/h2>/);
  });
});

describe('DOCX of the same overrides', () => {
  it('does not crash on non-string cells, titles, paragraphs or list items', async () => {
    const { renderToDocx } = await import('@/modules/accounting/services/afs/docxExportService');
    const section = { id: 's', sectionType: 'kpi_scorecard', sortOrder: 0, aiNarrative: null, content: { title: 'KPI Scorecard', blocks: [] },
      overrides: { title: 7, blocks: [{ type: 'paragraph', text: null }, { type: 'table', headers: ['A', 5], rows: [['x', 42], ['y', null], 'bad'] }, { type: 'list', items: [1, null] }] } } as unknown as AfsSection;
    const buf = await renderToDocx(doc('management_pack'), [section], 'Acme');
    expect(buf.length).toBeGreaterThan(1000);
    const afs = await renderToDocx(doc('afs'), [section], 'Acme');
    expect(afs.length).toBeGreaterThan(1000);
  });
});
