/**
 * VLM invoice pages — the request for a scanned invoice of more than one page.
 *
 * A scan often opens with a payment-request cover page, so page 1 alone has no
 * invoice on it (2026-10-17 benchmark: 0/6 on every multi-page scan). Pages
 * 1..min(N, MAX_INVOICE_PAGES) are rendered one after another and sent in ONE
 * call, with a note that some may be a cover page. The caller holds one
 * 'vlm-page-reads' slot around the render and the call, so a 3-page invoice
 * costs the same share of vLLM as a 1-page one.
 *
 * The page count and each page's text come from pdf-parse's text layer, which
 * marks every page "-- k of N --" AFTER page k, even a scan's empty ones.
 */

import { buildMultiImageContent } from './vlmCore';
import { renderPdfPage } from './vlmPdfRender';

export const MAX_INVOICE_PAGES = 3;
const CROSS_CHECK_LIMIT = 4000;
const PAGE_MARKER_LINE = /\n*-- \d+ of \d+ --\n*/;

export const MULTIPLE_INVOICES_WARNING = 'This PDF may contain more than one invoice.';

/** Page count from pdf-parse's "-- 1 of N --" page markers; 0 when absent. */
export function pdfPageCount(rawText?: string): number {
  const m = rawText?.match(/-- \d+ of (\d+) --/);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

export interface InvoicePagesRequest {
  content: Array<Record<string, unknown>>;
  warnings: string[];
}

/**
 * The user content for pages 1..min(total, 3) of `pdf`, or null when page 1
 * cannot be rendered (the caller then reads nothing as an image, as before).
 * A later page that fails is left out and named in a warning.
 */
export async function buildInvoicePagesRequest(
  pdf: Buffer,
  rawText: string,
  total: number,
): Promise<InvoicePagesRequest | null> {
  const last = Math.min(total, MAX_INVOICE_PAGES);
  const pngs: string[] = [];
  const read: number[] = [];
  const warnings: string[] = [];
  for (let page = 1; page <= last; page++) {
    const png = await renderPdfPage(pdf, page);
    if (png) {
      pngs.push(png);
      read.push(page);
    } else if (page === 1) {
      return null;
    } else {
      warnings.push(`Page ${page} of ${total} could not be read — check it by hand.`);
    }
  }
  if (total > last) warnings.push(`Read pages 1–${last} of ${total} — check later pages.`);

  // Word for word what the benchmark's json-multi mode sends (~/isaflow-ocr-bench/scripts/bench.py).
  let prompt = `You are given pages 1-${last} of a ${total}-page PDF, in page order. `
    + 'A page may be a cover page, a payment request, a remittance advice or terms and conditions: '
    + 'extract the SUPPLIER INVOICE (or credit note). Its totals are usually on the last invoice page. '
    + 'If the pages hold more than one separate invoice, extract the first one and add '
    + '"multipleInvoices": true to the JSON.\n\nExtract all accounting data from these document images.';
  const text = pageTexts(rawText, read).join('\n\n');
  if (text.trim()) {
    prompt += '\n\nThe PDF text layer of these pages also contains the following text (use it to cross-check '
      + `your extraction):\n\n${text.substring(0, CROSS_CHECK_LIMIT)}`;
  }
  return { content: buildMultiImageContent(pngs, 'image/png', prompt), warnings };
}

/** The text layer of each of `pages` (1-based), dropping pages with none. */
function pageTexts(rawText: string, pages: number[]): string[] {
  const all = rawText.split(PAGE_MARKER_LINE);
  return pages.map((p) => all[p - 1] ?? '').filter((t) => t.trim().length > 0);
}
