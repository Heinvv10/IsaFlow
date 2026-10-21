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
 * writes "-- k of N --" AFTER page k, even after a scan's empty pages. The
 * document's own text can print a line like that too, so only the markers
 * pdf-parse wrote count: the LAST one gives N, and page k ends at the first
 * "-- k of N --" after page k-1 ended.
 */

import { buildMultiImageContent } from './vlmCore';
import { renderPdfPage } from './vlmPdfRender';

export const MAX_INVOICE_PAGES = 3;
const CROSS_CHECK_LIMIT = 4000;
/**
 * Base64 characters of page images in one request. A 1754x1754 page is a few
 * hundred KB; a noisy scan can reach renderPdfPage's 20 MB cap, and three of
 * those would be an 80 MB request body held per slot. Pages past this are
 * left out and named, like a page that failed to render.
 */
export const MAX_REQUEST_IMAGE_CHARS = 24 * 1024 * 1024;
const MARKER = /-- (\d+) of (\d+) --/g;

export const MULTIPLE_INVOICES_WARNING = 'This PDF may contain more than one invoice.';

interface Marker { page: number; total: number; start: number; end: number }

function markersOf(rawText: string): Marker[] {
  return [...rawText.matchAll(MARKER)].map((m) => ({
    page: Number(m[1]), total: Number(m[2]), start: m.index, end: m.index + m[0].length,
  }));
}

/** Beyond any real PDF; a larger "N" is garbage, read as no count at all. */
const MAX_PLAUSIBLE_PAGES = 100_000;

/** Page count from pdf-parse's last "-- N of N --" page marker; 0 when absent or implausible. */
export function pdfPageCount(rawText?: string): number {
  const last = markersOf(rawText ?? '').at(-1);
  if (!last || last.page !== last.total || last.total > MAX_PLAUSIBLE_PAGES) return 0;
  return last.total;
}

/**
 * The text layer of pages 1..count of a `total`-page PDF, '' where a page has
 * none or cannot be told apart. One forward pass over the markers.
 */
export function pdfPageTexts(rawText: string, total: number, count: number): string[] {
  const markers = markersOf(rawText);
  const texts: string[] = [];
  let from = 0;
  let next = 0;
  for (let page = 1; page <= count; page++) {
    let end = markers[next];
    while (end && (end.page !== page || end.total !== total)) end = markers[++next];
    if (!end) return [...texts, ...Array<string>(count - texts.length).fill('')];
    texts.push(rawText.slice(from, end.start).trim());
    from = end.end;
    next++;
  }
  return texts;
}

export interface InvoicePagesRequest {
  content: Array<Record<string, unknown>>;
  warnings: string[];
}

/** "1-3" (with `dash`), or "1 and 3" when a page in the range was left out. */
function pageList(read: number[], dash = '-'): string {
  const contiguous = read.every((p, i) => p === i + 1);
  if (contiguous) return `1${dash}${read.length}`;
  return `${read.slice(0, -1).join(', ')} and ${read.at(-1)}`;
}

/**
 * The user content for pages 1..min(total, 3) of `pdf`, or null when page 1
 * cannot be rendered (the caller then reads nothing as an image, as before).
 * A later page that fails, or would push the request past
 * MAX_REQUEST_IMAGE_CHARS, is left out and named in a warning.
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
  let chars = 0;
  for (let page = 1; page <= last; page++) {
    const png = await renderPdfPage(pdf, page);
    if (png && (page === 1 || chars + png.length <= MAX_REQUEST_IMAGE_CHARS)) {
      pngs.push(png);
      read.push(page);
      chars += png.length;
    } else if (page === 1) {
      return null;
    } else {
      warnings.push(`Page ${page} of ${total} could not be read — check it by hand.`);
    }
  }
  if (total > last) warnings.push(`Read pages ${pageList(read, '–')} of ${total} — check later pages.`);

  // With every page read, the instruction is word for word the benchmark's json-multi mode (~/isaflow-ocr-bench/scripts/bench.py).
  let prompt = `You are given pages ${pageList(read)} of a ${total}-page PDF, in page order. `
    + 'A page may be a cover page, a payment request, a remittance advice or terms and conditions: '
    + 'extract the SUPPLIER INVOICE (or credit note). Its totals are usually on the last invoice page. '
    + 'If the pages hold more than one separate invoice, extract the first one and add '
    + '"multipleInvoices": true to the JSON.\n\nExtract all accounting data from these document images.';
  const pageText = pdfPageTexts(rawText, total, last);
  const text = read.map((p) => pageText[p - 1] ?? '').filter((t) => t.length > 0).join('\n\n');
  if (text) {
    prompt += '\n\nThe PDF text layer of these pages also contains the following text (use it to cross-check '
      + `your extraction):\n\n${text.substring(0, CROSS_CHECK_LIMIT)}`;
  }
  return { content: buildMultiImageContent(pngs, 'image/png', prompt), warnings };
}
