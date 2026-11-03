import { describe, it, expect } from 'vitest';
import { renderAfsToHtml } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsDocument, BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

const STYLES: BrandProfile['coverStyle'][] = ['classic', 'modern', 'bold', 'minimal'];

function brand(coverStyle: BrandProfile['coverStyle']): BrandProfile {
  return {
    id: 'bp-1', companyId: 'co-1', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b',
    fontFamily: 'professional', coverStyle, reportFooterText: null, createdAt: new Date(), updatedAt: new Date(),
  } as BrandProfile;
}

const PACK = {
  id: 'doc-p', companyId: 'co-1', fiscalYear: null, period: '2026-10', documentType: 'management_pack',
  reportingFramework: 'ifrs_smes', status: 'draft', version: 1,
} as unknown as AfsDocument;
const AFS = { ...PACK, id: 'doc-a', fiscalYear: 2026, period: null, documentType: 'afs' } as unknown as AfsDocument;

function ctx(document: AfsDocument, coverStyle: BrandProfile['coverStyle'], entityType?: 'trust'): AfsRenderContext {
  return {
    document, sections: [], brandProfile: brand(coverStyle), companyName: 'Acme (Pty) Ltd',
    registrationNumber: '2020/123456/07', entityType,
  } as AfsRenderContext;
}

describe('cover title follows the document type', () => {
  for (const style of STYLES) {
    it(`management pack, ${style} cover: names the pack and the month, never "Annual Financial Statements"`, () => {
      const html = renderAfsToHtml(ctx(PACK, style));
      expect(html).toContain('<h1 class="cover-title"');
      expect(html).toMatch(/<h1 class="cover-title"[^>]*>Management Pack<\/h1>/);
      expect(html).toContain('For the month of October 2026');
      expect(html).not.toContain('year ended 2026-10');
      expect(html).not.toContain('Annual Financial Statements');
      expect(html).toContain('<title>Management Pack — Acme (Pty) Ltd</title>');
    });

    it(`AFS, ${style} cover: unchanged`, () => {
      const html = renderAfsToHtml(ctx(AFS, style));
      expect(html).toMatch(/<h1 class="cover-title"[^>]*>Annual Financial Statements<\/h1>/);
      expect(html).toContain('<title>Annual Financial Statements — Acme (Pty) Ltd</title>');
      expect(html).not.toContain('Management Pack');
    });
  }

  it('trust AFS: <title> says "Financial Statements", cover heading unchanged', () => {
    const html = renderAfsToHtml(ctx(AFS, 'classic', 'trust'));
    expect(html).toMatch(/<h1 class="cover-title"[^>]*>Annual Financial Statements<\/h1>/);
    expect(html).toContain('<title>Financial Statements — Acme (Pty) Ltd</title>');
  });
});
