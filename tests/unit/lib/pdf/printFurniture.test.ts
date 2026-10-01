import { describe, expect, it } from 'vitest';
import { PDF_MARGIN_MM } from '@/lib/pdf/pdfTransport';
import { buildFooterHtml, buildPdfMetadata, FOOTER_PAGE_BOX_MM } from '@/lib/pdf/printFurniture';

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

  it('is two columns: a shrinkable title, and a right block whose page-number box cannot move', () => {
    const html = buildFooterHtml(base);
    expect(html).not.toContain('1fr auto 1fr');
    expect(html).not.toContain('space-between');
    // Title: may shrink, never wraps, ellipsis as the last resort.
    // Only the company name shrinks and ellipsises; " · pack · period" does not.
    expect(html).toMatch(/<span style="flex:1 1 auto;min-width:0;display:flex;white-space:nowrap"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">ISAFlow Demo \(Pty\) Ltd<\/span><span style="flex:none;white-space:pre"> · Board Pack · /);
    expect(html).toContain('box-sizing:border-box');
    // The side padding is the transport's margins, not a literal.
    expect(html).toContain(`padding:0 ${PDF_MARGIN_MM.right}mm 0 ${PDF_MARGIN_MM.left}mm`);
    // Right block does not shrink or wrap.
    expect(html).toContain('flex:none;white-space:nowrap');
    // Page-number box: fixed width, tabular figures, right aligned.
    expect(html).toMatch(new RegExp(`width:${FOOTER_PAGE_BOX_MM}mm;text-align:right;font-variant-numeric:tabular-nums`));
  });

  it('puts the confidentiality line in the right block, before the page number', () => {
    const html = buildFooterHtml({ ...base, draft: true });
    expect(html.indexOf('Confidential — for board use · DRAFT')).toBeGreaterThan(html.indexOf('flex:none'));
    expect(html.indexOf('Confidential')).toBeLessThan(html.indexOf('class="pageNumber"'));
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
