/**
 * VLM statement pages — reads a multi-page statement PDF one page at a time.
 *
 * The local vLLM takes ~55 s to read one dense statement page (output-token
 * bound, the same for a text layer or a picture), so a statement is read as one
 * call per page, a few at a time. Each page is sent as its own text layer when
 * it has one and as a rendered PNG when it does not (a scan); the raw PDF is
 * never sent, vLLM rejects it.
 *
 * All or nothing: a statement with more pages than the cap, or any page that
 * cannot be read, fails the whole read. A partial statement would import as a
 * complete one with transactions missing.
 *
 * The page count and each page's text come from pdf-parse's per-page `pages`
 * array. Its text-layer string marks pages "-- k of N --" AFTER page k, and the
 * markers exist even for a scan with no text, so the count is reliable.
 */

import { log } from '@/lib/logger';
import { renderPdfPage } from './vlmPdfRender';
import { sharedSlotLimiter, envLimit } from './vlmLimiter';

/** A page whose text (trimmed) is shorter than this is treated as a scan and rendered. */
export const MIN_PAGE_TEXT_CHARS = 200;
const DEFAULT_MAX_STATEMENT_PAGES = 20;

export type StatementReadCode = 'too_many_pages' | 'unreadable' | 'page_failed';

/** The message is safe to show the user. */
export class StatementReadError extends Error {
  constructor(readonly code: StatementReadCode, message: string) {
    super(message);
    this.name = 'StatementReadError';
  }
}

/** One page for the VLM: its text layer, or (when the page has none) a rendered PNG. */
export interface PageRequest {
  page: number;
  total: number;
  text: string | null;
  pngBase64: string | null;
}

export type StatementKind = 'bank' | 'supplier';

/**
 * Page reads (render + VLM call) at once, so statements can never take more
 * than this many of vLLM's slots (callVlmChat's own limiter still applies).
 * `VLM_MAX_STATEMENT_PAGE_READS` is read once, at load.
 */
const pageReads = sharedSlotLimiter('vlm-statement-pages', envLimit('VLM_MAX_STATEMENT_PAGE_READS', 2));

interface PdfParseV2 {
  PDFParse: new (opts: { data: Buffer }) => { getText(): Promise<{ pages: Array<{ text: string }> }> };
}

/** True when a page's text layer is long enough to read as text rather than as a picture. */
export function pageHasUsableText(text: string): boolean {
  return text.trim().length >= MIN_PAGE_TEXT_CHARS;
}

/** The text layer of each page, in page order ('' for a page with none). */
export async function readPdfPageTexts(pdf: Buffer): Promise<string[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require('pdf-parse') as PdfParseV2;
    const parsed = await new PDFParse({ data: pdf }).getText();
    return parsed.pages.map((p) => p.text ?? '');
  } catch (err) {
    log.warn('Statement PDF could not be read', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-statement-pages');
    throw new StatementReadError('unreadable',
      'The PDF could not be read — it may be damaged or password-protected.');
  }
}

export function maxStatementPages(): number {
  return envLimit('VLM_MAX_STATEMENT_PAGES', DEFAULT_MAX_STATEMENT_PAGES);
}

/**
 * Read every page of `pdf` through `readPage` and return the results in page
 * order. `readPage` returns null for a page it could not read.
 *
 * `onProgress(done, total)` runs after each page; a failure in it is logged and
 * does not fail the read (it is a heartbeat, not part of the result).
 */
export async function readStatementPdf<T>(
  pdf: Buffer,
  kind: StatementKind,
  readPage: (req: PageRequest) => Promise<T | null>,
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<T[]> {
  const texts = await readPdfPageTexts(pdf);
  const total = texts.length;
  const cap = maxStatementPages();
  if (total > cap) {
    const hint = kind === 'bank' ? "Split it into smaller files, or import the bank's CSV export." : 'Split it into smaller files.';
    throw new StatementReadError('too_many_pages',
      `This statement has ${total} pages; the most IsaFlow reads is ${cap}. ${hint}`);
  }

  let failed = false;
  let done = 0;
  const results = await Promise.allSettled(texts.map(async (text, i) => {
    const value = await pageReads.run(async () => {
      // Pages still queued when one fails are not started: the statement is lost already.
      if (failed) throw new StatementReadError('page_failed', 'Not read: an earlier page failed.');
      try {
        return await readOnePage(pdf, text, i + 1, total, readPage);
      } catch (err) {
        failed = true;
        throw err;
      }
    });
    done += 1;
    await heartbeat(onProgress, done, total);
    return value;
  }));

  // The limiter is FIFO, so a page skipped above comes after the page that failed: the first rejection is the cause.
  const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (firstFailure) throw firstFailure.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

async function readOnePage<T>(
  pdf: Buffer, text: string, page: number, total: number,
  readPage: (req: PageRequest) => Promise<T | null>,
): Promise<T> {
  const failure = () => new StatementReadError('page_failed',
    `Page ${page} of ${total} could not be read. Retry the import.`);
  const hasText = pageHasUsableText(text);
  let png: string | null = null;
  if (!hasText) {
    png = await renderPdfPage(pdf, page);
    if (!png) throw failure();
  }
  let value: T | null;
  try {
    value = await readPage({ page, total, text: hasText ? text : null, pngBase64: png });
  } catch (err) {
    log.error('Statement page read threw', {
      page, total, error: err instanceof Error ? err.message : String(err),
    }, 'vlm-statement-pages');
    throw failure();
  }
  if (value === null) throw failure();
  return value;
}

async function heartbeat(
  onProgress: ((done: number, total: number) => Promise<void>) | undefined, done: number, total: number,
): Promise<void> {
  if (!onProgress) return;
  try {
    await onProgress(done, total);
  } catch (err) {
    log.warn('Statement progress heartbeat failed', {
      done, total, error: err instanceof Error ? err.message : String(err),
    }, 'vlm-statement-pages');
  }
}
