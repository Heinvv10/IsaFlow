import { describe, it, expect } from 'vitest';
import { renderAfsToHtml } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import type { AfsDocument, AfsSection, BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

const BRAND_PROFILE: BrandProfile = {
  id: 'bp-1',
  companyId: 'co-1',
  logoUrl: 'https://cdn.example.com/logo.png',
  primaryColour: '#1a3a5c',
  secondaryColour: '#c8a86b',
  fontFamily: 'professional',
  coverStyle: 'classic',
  reportFooterText: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DOCUMENT: AfsDocument = {
  id: 'doc-1',
  companyId: 'co-1',
  fiscalYear: 2025,
  documentType: 'afs',
  reportingFramework: 'ifrs_smes',
  status: 'draft',
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
} as AfsDocument;

const SECTION_WITH_TABLE: AfsSection = {
  id: 'sec-1',
  documentId: 'doc-1',
  sectionType: 'note_1',
  status: 'auto_generated',
  content: {
    title: 'Trade Receivables',
    blocks: [
      { type: 'heading', text: '10. Trade Receivables', level: 2 },
      { type: 'paragraph', text: 'Trade receivables are recognised at fair value.' },
      {
        type: 'table',
        headers: ["Description", "2025 R'000", "2024 R'000"],
        rows: [
          ['Trade debtors', '1 200', '980'],
          ['Less: allowance for impairment', '(50)', '(30)'],
          ['Net trade receivables', '1 150', '950'],
        ],
      },
    ],
  },
} as unknown as AfsSection;

const CTX: AfsRenderContext = {
  document: DOCUMENT,
  sections: [SECTION_WITH_TABLE],
  brandProfile: BRAND_PROFILE,
  companyName: 'Test Company (Pty) Ltd',
  registrationNumber: '2020/123456/07',
  coverPhotoUrl: 'https://cdn.example.com/cover.jpg',
};

describe('renderAfsToHtml', () => {
  it('returns a non-empty HTML string', () => {
    const html = renderAfsToHtml(CTX);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(100);
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('includes company name in output', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('Test Company (Pty) Ltd');
  });

  it('includes classic cover elements', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('cover-classic');
    expect(html).toContain('cover-overlay');
  });

  it('renders modern cover when coverStyle is modern', () => {
    const ctx: AfsRenderContext = {
      ...CTX,
      brandProfile: { ...BRAND_PROFILE, coverStyle: 'modern' },
    };
    const html = renderAfsToHtml(ctx);
    expect(html).toContain('cover-modern');
    expect(html).toContain('cover-panel');
  });

  it('renders bold cover when coverStyle is bold', () => {
    const ctx: AfsRenderContext = {
      ...CTX,
      brandProfile: { ...BRAND_PROFILE, coverStyle: 'bold' },
    };
    const html = renderAfsToHtml(ctx);
    expect(html).toContain('cover-bold');
  });

  it('renders minimal cover when coverStyle is minimal', () => {
    const ctx: AfsRenderContext = {
      ...CTX,
      brandProfile: { ...BRAND_PROFILE, coverStyle: 'minimal' },
    };
    const html = renderAfsToHtml(ctx);
    expect(html).toContain('cover-minimal');
    expect(html).toContain('cover-rule');
  });

  it('renders table with correct structure', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('financial-table');
    expect(html).toContain('Trade Receivables');
    expect(html).toContain('Trade debtors');
  });

  it('injects watermark when option is set', () => {
    const html = renderAfsToHtml(CTX, { watermark: 'DRAFT — NOT FOR DISTRIBUTION' });
    expect(html).toContain('DRAFT — NOT FOR DISTRIBUTION');
    expect(html).toContain('class="watermark"');
  });

  it('does not include watermark by default', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).not.toContain('class="watermark"');
  });

  it('embeds CSS print rules', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('break-inside: avoid');
    expect(html).toContain('display: table-header-group');
    expect(html).toContain('widows: 2');
  });

  it('note headings use note-heading class', () => {
    const html = renderAfsToHtml(CTX);
    expect(html).toContain('class="note-heading"');
    expect(html).toContain('10. Trade Receivables');
  });
});
