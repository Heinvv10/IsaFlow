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
    expect(pdfPageCount(layer(['x -- 1 of 99999999999999999999 --']))).toBe(1);
    expect(pdfPageCount('a\n\n-- 200000 of 200000 --\n\n')).toBe(0);
  });

  it('keeps a one-page PDF that prints a marker-like line on the one-page path', () => {
    expect(pdfPageCount(layer(['Remittance -- 1 of 3 -- attached']))).toBe(1);
  });

  it('splits the text per page, ignoring a marker-like line in a page body', () => {
    const raw = layer(['cover -- 2 of 3 -- note', 'invoice', 'terms']);
    expect(pdfPageTexts(raw, 3, 3)).toEqual(['cover -- 2 of 3 -- note', 'invoice', 'terms']);
    expect(pdfPageTexts(layer(['cover -- 1 of 9 -- x', 'invoice', 'terms']), 3, 3))
      .toEqual(['cover -- 1 of 9 -- x', 'invoice', 'terms']);
  });

  it('gives empty text rather than the wrong page when markers are missing', () => {
    expect(pdfPageTexts('one\n\n-- 1 of 3 --\n\ntwo', 3, 3)).toEqual(['one', '', '']);
    expect(pdfPageTexts(layer(['a', 'b', 'c', 'd']), 4, 2)).toEqual(['a', 'b']);
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

  it('names the pages read in the over-cap warning when one of them was skipped', async () => {
    render.mockImplementation(async (_pdf, page) => (page === 2 ? null : 'png'));
    const req = await buildInvoicePagesRequest(PDF, layer(['', '', '', '', '']), 5);
    expect(req!.warnings).toEqual([
      'Page 2 of 5 could not be read — check it by hand.',
      'Read pages 1 and 3 of 5 — check later pages.',
    ]);
  });

  it('caps the cross-check text at 4,000 characters', async () => {
    render.mockResolvedValue('png');
    const req = await buildInvoicePagesRequest(PDF, layer(['x'.repeat(9000), 'y', 'z']), 3);
    const text = (req!.content.at(-1) as { text: string }).text;
    const cross = text.slice(text.indexOf('cross-check your extraction):\n\n') + 'cross-check your extraction):\n\n'.length);
    expect(cross).toBe('x'.repeat(4000));
  });
});
