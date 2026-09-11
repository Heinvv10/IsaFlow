/**
 * A management pack's PDF carried the cover "Annual Financial Statements / For the year ended
 * 2026-06": the renderer hard-coded the AFS cover for every document. A pack gets its own title.
 *
 * AFS signatures fingerprint the render, so the AFS render must not move by one byte: the digests
 * below were taken from the renderer BEFORE the pack title was added, for every cover style, a
 * watermark and the trust title.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsDocument, AfsSection, BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

const at = new Date('2026-01-01T00:00:00Z');
const brand = (coverStyle: BrandProfile['coverStyle']): BrandProfile => ({
  id: 'bp', companyId: 'co', logoUrl: 'https://cdn.example.com/logo.png', primaryColour: '#1a3a5c',
  secondaryColour: '#c8a86b', fontFamily: 'professional', coverStyle, reportFooterText: null, createdAt: at, updatedAt: at,
});
const doc = (documentType: AfsDocument['documentType'], period: string | null, fiscalYear: number | null) => ({
  id: 'doc', companyId: 'co', fiscalYear, period, documentType, reportingFramework: 'ifrs_smes', status: 'draft',
  version: 1, createdAt: at, updatedAt: at,
}) as AfsDocument;
const section = {
  id: 'sec', documentId: 'doc', sectionType: 'note_1', status: 'auto_generated',
  content: { title: 'Trade Receivables', blocks: [{ type: 'paragraph', text: 'Trade receivables & other <items>.' }] },
} as unknown as AfsSection;
const ctx = (document: AfsDocument, coverStyle: BrandProfile['coverStyle']): AfsRenderContext => ({
  document, sections: [section], brandProfile: brand(coverStyle), companyName: 'Acme (Pty) Ltd', registrationNumber: '2019/000001/07',
});
const sha = (html: string) => createHash('sha256').update(html, 'utf8').digest('hex');

describe('the cover of a rendered document', () => {
  it('an AFS document renders byte-identically to the renderer before pack titles existed', () => {
    const afs = doc('afs', null, 2026);
    expect({
      classic: sha(renderAfsToHtml(ctx(afs, 'classic'))),
      modern: sha(renderAfsToHtml(ctx(afs, 'modern'))),
      bold: sha(renderAfsToHtml(ctx(afs, 'bold'))),
      minimal: sha(renderAfsToHtml(ctx(afs, 'minimal'))),
      periodCover: sha(renderAfsToHtml(ctx(doc('afs', '2026-02', null), 'classic'))),
      watermarked: sha(renderAfsToHtml(ctx(afs, 'classic'), { watermark: 'DRAFT' })),
      trust: sha(renderAfsToHtml({ ...ctx(afs, 'modern'), entityType: 'trust' })),
    }).toEqual({
      classic: '29f0aef2d9e5755c4f7cbdcfdded6db48b3814fdae2d5b2c9f0ffa0a4ade83ec',
      modern: '94994692e8c7d4ca118ed04889b8d993b20455fc77e6628787daa01bf9eab4e3',
      bold: '19ea9a3dd8fb2d28fb62a8d033f8b9dc2ae97758733a273157edff5a8e9a492a',
      minimal: 'adf5ea4e38a27844a6857e9945cccda6845c1eea69be2b11b5eb0bb217901382',
      periodCover: '228df66395f23e8c0313e5e6b7d894245dbbd7dfa0b4d248ab97b3d6553d94aa',
      watermarked: '4d2850d72c2a7f2ae946ebdd9a824418ee6041fc4cb648c97d0a22e343aac7cb',
      trust: '3ee6f4ddfdfb703cf61fb0152b79fa996a1d0f218b276183abc58eb4bad1574d',
    });
  });

  it.each(['classic', 'modern', 'bold', 'minimal'] as const)('a management pack is titled Management Accounts for its period (%s cover)', (style) => {
    const html = renderAfsToHtml(ctx(doc('management_pack', '2026-06', null), style));
    expect(html).toContain('Management Accounts</h1>');
    expect(html).toContain('For the period 2026-06</p>');
    expect(html).toContain('<title>Management Accounts — Acme (Pty) Ltd</title>');
    expect(html, 'a management pack is not annual financial statements').not.toContain('Annual Financial Statements');
    expect(html).not.toContain('For the year ended');
  });
});
