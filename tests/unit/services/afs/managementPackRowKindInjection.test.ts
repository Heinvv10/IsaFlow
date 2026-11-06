/**
 * `rowKinds` is stored section content (a tenant writes it through the overrides route), and the PDF
 * renderer puts it in a class attribute that WeasyPrint parses. Only the four known kinds may reach
 * the page; anything else is a plain row, and the overrides route refuses it.
 */
import { describe, expect, it } from 'vitest';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import { safeRowKind } from '@/modules/accounting/services/afs/managementPackSections';
import type { AfsDocument, AfsSection, BrandProfile, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

const EVIL = 'x"><img src=http://127.0.0.1/ssrf>';
const brand = { id: 'b', companyId: 'c', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional', coverStyle: 'classic', reportFooterText: null, createdAt: new Date(), updatedAt: new Date() } as BrandProfile;
const PACK = { id: 'd', companyId: 'c', fiscalYear: null, period: '2026-10', documentType: 'management_pack', reportingFramework: 'ifrs_smes', status: 'draft', version: 1 } as unknown as AfsDocument;
const table = (rowKinds: unknown): NoteContentBlock => ({ type: 'table', headers: ['', 'A'], rows: [['one', '1'], ['two', '2']], rowKinds } as unknown as NoteContentBlock);
const pack = (blocks: NoteContentBlock[], where: 'content' | 'overrides'): string => renderAfsToHtml({
  document: PACK, brandProfile: brand, companyName: 'Acme', registrationNumber: '1',
  sections: [{ id: 's1', sectionType: 'kpi_scorecard', sortOrder: 0, aiNarrative: null,
    content: where === 'content' ? { title: 'KPI Scorecard', blocks } : { title: 'KPI Scorecard', blocks: [] },
    overrides: where === 'overrides' ? { title: 'KPI Scorecard', blocks } : null } as unknown as AfsSection],
} as AfsRenderContext);

describe('the PDF html never carries a stored row kind unchecked', () => {
  it.each(['content', 'overrides'] as const)('a hostile kind in %s is a plain row, and no markup reaches the page', (where) => {
    const html = pack([table([EVIL, 'subtotal'])], where);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('127.0.0.1');
    expect(html).not.toContain(EVIL);
    expect(html).toMatch(/<tr><td>one<\/td>/);
    expect(html).toContain('<tr class="row-subtotal"><td>two</td>');
  });

  it('a non-string, a prototype name and a non-array are plain rows', () => {
    for (const kinds of [[{ a: 1 }, 'constructor'], 'total', null]) {
      const html = pack([table(kinds)], 'content');
      expect(html).not.toContain('class="row-');
      expect(html).toMatch(/<tr><td>one<\/td>/);
    }
  });

  it('the four known kinds still style their rows', () => {
    const html = pack([table(['heading', 'total'])], 'content');
    expect(html).toContain('<tr class="row-heading">');
    expect(html).toContain('<tr class="row-total">');
  });
});

describe('safeRowKind', () => {
  it('passes the four kinds and nothing else', () => {
    for (const k of ['heading', 'line', 'subtotal', 'total']) expect(safeRowKind(k)).toBe(k);
    for (const k of [EVIL, 'constructor', '__proto__', '', 5, null, undefined, ['total']]) expect(safeRowKind(k)).toBe('line');
  });
});
