import { describe, expect, it } from 'vitest';
import {
  buildFooterHtml, buildPdfMetadata, FOOTER_CONTENT_MM, FOOTER_GAP_MM, FOOTER_PAGE_BOX_MM, FOOTER_PT,
  footerRightText, footerTitleText,
} from '@/lib/pdf/printFurniture';
import { PT_MM, textWidthEms, WIDTH_SAFETY } from '@/modules/accounting/services/packs/pages/packTextMetrics';

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
    expect(html).toMatch(/<span style="flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">ISAFlow Demo/);
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

  /**
   * THE TITLE MUST FIT ITS COLUMN, measured with the pack's own text ruler
   * (em table x WIDTH_SAFETY, an upper bound), not asserted by eye. The
   * footer is set in the same face the ruler is calibrated for.
   */
  it.each([
    ['final', false],
    ['draft', true],
  ])('fits the longest realistic %s title on one line', (_n, draft) => {
    const f = { ...base, companyName: 'Brightsphere (Pty) Ltd', period: '1 January 2026 to 7 September 2026', draft };
    const mm = (text: string) => textWidthEms(text) * WIDTH_SAFETY * FOOTER_PT * PT_MM;
    const rightMm = mm(footerRightText(f)) + FOOTER_GAP_MM / 3 + FOOTER_PAGE_BOX_MM;
    const columnMm = FOOTER_CONTENT_MM - rightMm - FOOTER_GAP_MM;
    expect(mm(footerTitleText(f)), `title needs ${mm(footerTitleText(f)).toFixed(1)}mm of ${columnMm.toFixed(1)}mm`)
      .toBeLessThan(columnMm);
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
