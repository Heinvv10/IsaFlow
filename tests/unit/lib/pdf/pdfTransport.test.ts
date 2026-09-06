import { describe, it, expect } from 'vitest';
import { PDF_MARGIN_MM } from '@/lib/pdf/pdfTransport';

describe('PDF_MARGIN_MM', () => {
  it('is the single source of truth for the page margin — styles/packPrint.css declares none', () => {
    // Neither transport sets preferCSSPageSize, so a CSS @page margin would be
    // silently ignored by Chromium. This is the only place the margin lives.
    expect(PDF_MARGIN_MM).toEqual({ top: 20, bottom: 22, left: 18, right: 18 });
  });
});
