/**
 * A statement PDF is read one page at a time: a page with a text layer goes to
 * the VLM as text, a page without one as a rendered PNG, and any failure or an
 * over-long statement fails the WHOLE read (never a partial statement).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statementRows, syntheticPdf } from '../helpers/syntheticPdf';

const render = vi.hoisted(() => vi.fn<(buf: Buffer, page: number) => Promise<string | null>>());
vi.mock('@/modules/accounting/services/bank/vlmPdfRender', () => ({ renderPdfPage: render }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  pageHasUsableText, readPdfPageTexts, readStatementPdf, StatementReadError, type PageRequest,
} from '@/modules/accounting/services/bank/vlmStatementPages';

/** Lines whose text layer, once extracted and trimmed, is exactly `n` characters (pdf.js clips a line at the page edge). */
const line = (n: number): string[] => {
  const full = Math.floor(n / 41);
  const rest = n - full * 41;
  return [...Array.from({ length: full }, () => 'X'.repeat(40)), ...(rest > 0 ? ['Y'.repeat(rest)] : [])];
};
const echo = async (req: PageRequest) => req.page;
const rejection = async (p: Promise<unknown>): Promise<StatementReadError> => {
  try { await p; } catch (err) { return err as StatementReadError; }
  throw new Error('expected a rejection');
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  render.mockReset();
  render.mockResolvedValue('PNG');
});
afterEach(() => { delete process.env.VLM_MAX_STATEMENT_PAGES; });

describe('readPdfPageTexts', () => {
  it('returns each page\'s own text, in order, and "" for a page with no text layer', async () => {
    const texts = await readPdfPageTexts(syntheticPdf([statementRows(5, 'AAA'), [], statementRows(2, 'CCC')]));
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('AAA');
    expect(texts[0]).not.toContain('CCC');
    expect(texts[1].trim()).toBe('');
    expect(texts[2]).toContain('CCC');
    expect(texts[2]).not.toContain('AAA');
  });

  it('does not put pdf-parse\'s "-- k of N --" markers in a page\'s text', async () => {
    const texts = await readPdfPageTexts(syntheticPdf([statementRows(2, 'AAA'), statementRows(2, 'BBB')]));
    expect(texts.join('')).not.toMatch(/-- \d+ of \d+ --/);
  });

  it('refuses bytes that are not a PDF with a user-safe "unreadable" error', async () => {
    const err = await rejection(readPdfPageTexts(Buffer.from('not a pdf at all')));
    expect(err).toBeInstanceOf(StatementReadError);
    expect(err.code).toBe('unreadable');
    expect(err.message).toBe('The PDF could not be read — it may be damaged or password-protected.');
  });
});

describe('readStatementPdf page cap', () => {
  const pdf3 = syntheticPdf([statementRows(5, 'A'), statementRows(5, 'B'), statementRows(5, 'C')]);

  it('fails the whole read before any page is read when there are more pages than the cap', async () => {
    process.env.VLM_MAX_STATEMENT_PAGES = '2';
    const readPage = vi.fn(echo);
    const err = await rejection(readStatementPdf(pdf3, 'bank', readPage));
    expect(err.code).toBe('too_many_pages');
    expect(err.message).toBe("This statement has 3 pages; the most IsaFlow reads is 2. Split it into smaller files, or import the bank's CSV export.");
    expect(readPage).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('reads a statement with exactly the cap\'s page count', async () => {
    process.env.VLM_MAX_STATEMENT_PAGES = '3';
    expect(await readStatementPdf(pdf3, 'bank', echo)).toEqual([1, 2, 3]);
  });

  it('defaults the cap to 20 pages', async () => {
    const pages = Array.from({ length: 21 }, () => statementRows(1, 'P'));
    const err = await rejection(readStatementPdf(syntheticPdf(pages), 'bank', echo));
    expect(err.code).toBe('too_many_pages');
    expect(err.message).toContain('21 pages; the most IsaFlow reads is 20');
  });

  it('does not tell a supplier-statement uploader to import a bank CSV', async () => {
    process.env.VLM_MAX_STATEMENT_PAGES = '2';
    const err = await rejection(readStatementPdf(pdf3, 'supplier', echo));
    expect(err.message).toBe('This statement has 3 pages; the most IsaFlow reads is 2. Split it into smaller files.');
  });
});

describe('pageHasUsableText', () => {
  it('counts the trimmed text, not the padding around it', () => {
    expect(pageHasUsableText(`  \n${'a'.repeat(199)}\n  `)).toBe(false);
    expect(pageHasUsableText(`  \n${'a'.repeat(200)}\n  `)).toBe(true);
    expect(pageHasUsableText(' '.repeat(500))).toBe(false);
  });
});

describe('readStatementPdf text or picture, per page', () => {
  it('sends a page with >= 200 characters of text as text, and renders the others', async () => {
    const pdf = syntheticPdf([line(200), line(199), []]);
    const seen: PageRequest[] = [];
    await readStatementPdf(pdf, 'bank', async (req) => { seen.push(req); return req.page; });
    seen.sort((a, b) => a.page - b.page);

    expect(seen[0].text!.trim()).toHaveLength(200);
    expect(seen[0].pngBase64).toBeNull();
    expect(seen[1].text).toBeNull();
    expect(seen[1].pngBase64).toBe('PNG');
    expect(seen[2].text).toBeNull();
    expect(seen[2].pngBase64).toBe('PNG');
    expect(render.mock.calls.map((c) => c[1]).sort()).toEqual([2, 3]);
    expect(render.mock.calls.every((c) => Buffer.isBuffer(c[0]))).toBe(true);
  });

  it('tells each read which page of how many it is', async () => {
    const seen: Array<[number, number]> = [];
    await readStatementPdf(syntheticPdf([line(250), line(250)]), 'bank', async (req) => {
      seen.push([req.page, req.total]);
      return 1;
    });
    expect(seen.sort()).toEqual([[1, 2], [2, 2]]);
  });
});

describe('readStatementPdf is all or nothing', () => {
  const pdf3 = syntheticPdf([line(250), line(250), line(250)]);

  it('returns the results in page order even when a later page finishes first', async () => {
    const out = await readStatementPdf(pdf3, 'bank', async (req) => {
      await sleep(req.page === 1 ? 30 : 1);
      return `p${req.page}`;
    });
    expect(out).toEqual(['p1', 'p2', 'p3']);
  });

  it('fails the whole read when the VLM gives nothing for one page', async () => {
    const err = await rejection(readStatementPdf(pdf3, 'bank', async (req) => (req.page === 2 ? null : req.page)));
    expect(err.code).toBe('page_failed');
    expect(err.message).toBe('Page 2 of 3 could not be read. Retry the import.');
  });

  it('fails the whole read when a page read throws, without leaking the error text', async () => {
    const err = await rejection(readStatementPdf(pdf3, 'bank', async (req) => {
      if (req.page === 3) throw new Error('connect ECONNREFUSED 10.0.0.9:8000');
      return req.page;
    }));
    expect(err.code).toBe('page_failed');
    expect(err.message).not.toContain('ECONNREFUSED');
  });

  it('fails the whole read when a scanned page cannot be rendered, without calling the VLM for it', async () => {
    render.mockResolvedValue(null);
    const readPage = vi.fn(echo);
    const err = await rejection(readStatementPdf(syntheticPdf([line(250), []]), 'bank', readPage));
    expect(err.code).toBe('page_failed');
    expect(err.message).toContain('Page 2 of 2');
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(readPage.mock.calls[0][0].page).toBe(1);
  });

  it('does not start pages that were still queued once one has failed', async () => {
    const pdf6 = syntheticPdf(Array.from({ length: 6 }, () => line(250)));
    const started: number[] = [];
    const err = await rejection(readStatementPdf(pdf6, 'bank', async (req) => {
      started.push(req.page);
      await sleep(5);
      return req.page === 1 ? null : req.page;
    }));
    expect(err.message).toContain('Page 1 of 6');
    expect(started.sort()).toEqual([1, 2]);
  });
});

describe('readStatementPdf concurrency', () => {
  const pdf6 = syntheticPdf(Array.from({ length: 6 }, () => line(250)));

  it('reads pages in parallel, but never more than two at once across statements', async () => {
    let live = 0;
    let peak = 0;
    const slow = async (req: PageRequest) => {
      live++;
      peak = Math.max(peak, live);
      await sleep(10);
      live--;
      return req.page;
    };
    await Promise.all([readStatementPdf(pdf6, 'bank', slow), readStatementPdf(pdf6, 'supplier', slow)]);
    expect(peak).toBe(2);
  });
});

describe('readStatementPdf progress', () => {
  const pdf3 = syntheticPdf([line(250), line(250), line(250)]);

  it('reports (0, total) first, then (done, total) after each page', async () => {
    const calls: Array<[number, number]> = [];
    await readStatementPdf(pdf3, 'bank', echo, async (done, total) => { calls.push([done, total]); });
    expect(calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it('reports (0, total) before the first page is read, so a job queued behind other reads is not taken for dead', async () => {
    const order: string[] = [];
    await readStatementPdf(pdf3, 'bank', async (req) => { order.push(`page ${req.page}`); return req.page; },
      async (done) => { order.push(`beat ${done}`); });
    expect(order[0]).toBe('beat 0');
    expect(order.indexOf('page 1')).toBeGreaterThan(0);
  });

  it('does not report a statement it refuses for length', async () => {
    process.env.VLM_MAX_STATEMENT_PAGES = '2';
    const onProgress = vi.fn();
    await rejection(readStatementPdf(pdf3, 'bank', echo, onProgress));
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('does not fail the read when the progress write fails', async () => {
    const out = await readStatementPdf(pdf3, 'bank', echo, async () => { throw new Error('db down'); });
    expect(out).toEqual([1, 2, 3]);
  });
});
