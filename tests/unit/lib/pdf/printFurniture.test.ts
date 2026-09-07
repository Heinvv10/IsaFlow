import { describe, expect, it } from 'vitest';
import { buildFooterHtml, buildPdfMetadata } from '@/lib/pdf/printFurniture';

const base = {
  companyName: 'ISAFlow Demo (Pty) Ltd', packLabel: 'Board Pack',
  period: '1 Jan 2026 – 31 Aug 2026', confidentiality: 'Confidential — for board use',
  draft: false,
};

describe('buildFooterHtml', () => {
  it('carries company, pack, period, confidentiality and n / m', () => {
    const html = buildFooterHtml(base);
    expect(html).toContain('ISAFlow Demo');
    expect(html).toContain('Board Pack');
    expect(html).toContain('Confidential — for board use');
    // Chromium substitutes these classes; CSS @bottom-* margin boxes are not
    // implemented in Blink and would silently render nothing.
    expect(html).toContain('class="pageNumber"');
    expect(html).toContain('class="totalPages"');
  });

  it('marks a draft pack in the footer', () => {
    expect(buildFooterHtml({ ...base, draft: true })).toMatch(/DRAFT/);
    expect(buildFooterHtml(base)).not.toMatch(/DRAFT/);
  });

  it('escapes a company name containing markup', () => {
    const html = buildFooterHtml({ ...base, companyName: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('buildPdfMetadata', () => {
  it('titles the document as the reader will see it in a PDF viewer', () => {
    const meta = buildPdfMetadata(base);
    expect(meta.title).toBe('ISAFlow Demo (Pty) Ltd — Board Pack — 1 Jan 2026 – 31 Aug 2026');
    expect(meta.creator).toContain('IsaFlow');
  });

  it('marks a draft in the subject line', () => {
    expect(buildPdfMetadata({ ...base, draft: true }).subject).toMatch(/[Dd]raft/);
  });
});
