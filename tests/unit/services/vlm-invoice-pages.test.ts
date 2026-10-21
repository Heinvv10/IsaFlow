/**
 * The page count and per-page text of a multi-page invoice come from
 * pdf-parse's "-- k of N --" markers, which the document's own text can
 * imitate; and three huge page images must not become one huge request.
 */
import { describe, expect, it, vi } from 'vitest';

const render = vi.hoisted(() => vi.fn<(pdf: Buffer, page: number) => Promise<string | null>>());
vi.mock('@/modules/accounting/services/bank/vlmPdfRender', () => ({ renderPdfPage: render }));

import {
  buildInvoicePagesRequest, MAX_REQUEST_IMAGE_CHARS, pdfPageCount, pdfPageTexts,
} from '@/modules/accounting/services/bank/vlmInvoicePages';

const PDF = Buffer.from('%PDF-1.7');
const layer = (pages: string[]) => pages.map((t, i) => `${t}\n\n-- ${i + 1} of ${pages.length} --\n\n`).join('');

describe('pdf-parse page markers', () => {
  it('counts pages from the last marker, not one printed in the document', () => {
    expect(pdfPageCount(layer(['Statement line -- 1 of 9 -- carried', 'b']))).toBe(2);
    expect(pdfPageCount(layer(['a']))).toBe(1);
    expect(pdfPageCount('no markers at all')).toBe(0);
    expect(pdfPageCount('')).toBe(0);
  });

  it('splits the text per page, ignoring a marker-like line in a page body', () => {
    const raw = layer(['cover -- 2 of 3 -- note', 'invoice', 'terms']);
    expect(pdfPageTexts(raw, 3)).toEqual(['cover -- 2 of 3 -- note', 'invoice', 'terms']);
  });

  it('gives empty text rather than the wrong page when markers are missing', () => {
    expect(pdfPageTexts('one\n\n-- 1 of 3 --\n\ntwo', 3)).toEqual(['one', '', '']);
  });
});

describe('buildInvoicePagesRequest', () => {
  it('leaves out a page that would push the request past the image budget, and names it', async () => {
    const big = 'A'.repeat(MAX_REQUEST_IMAGE_CHARS / 2 + 1);
    render.mockImplementation(async (_pdf, page) => (page === 3 ? 'small' : big));
    const req = await buildInvoicePagesRequest(PDF, layer(['', '', '']), 3);
    const parts = req!.content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
    expect(parts.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url.length))
      .toEqual([big.length, 'small'.length].map((n) => n + 'data:image/png;base64,'.length));
    expect(req!.warnings).toEqual(['Page 2 of 3 could not be read — check it by hand.']);
    expect(parts.at(-1)!.text).toMatch(/^You are given pages 1 and 3 of a 3-page PDF/);
  });
});
