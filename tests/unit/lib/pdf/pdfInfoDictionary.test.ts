/**
 * The PDF metadata the Playwright transport used to drop.
 *
 * Proved against a REAL Chromium PDF — Playwright's own bundled browser, the
 * same `page.pdf()` call the transport makes — and read back with pdf.js
 * (through `pdf-parse`, already a dependency), which is a reader this repo did
 * not write. A writer checked by its author's own parser proves that the two
 * agree, not that the file is a PDF.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { writePdfInfoDictionary, pdfString } from '@/lib/pdf/pdfInfoDictionary';

const METADATA = {
  title: 'ISAFlow Demo (Pty) Ltd — Board Pack',
  author: 'ISAFlow Demo (Pty) Ltd',
  subject: 'Board Pack · 1 January 2026 to 7 September 2026',
  creator: 'IsaFlow',
};

let browser: Browser;
let chromiumPdf: Buffer;
beforeAll(async () => {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<h1>A board pack</h1>');
  chromiumPdf = await page.pdf({ format: 'A4' });
  await page.close();
}, 120_000);
afterAll(async () => { await browser?.close(); });

async function readInfo(pdf: Buffer): Promise<Record<string, unknown>> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getInfo(): Promise<{ info: Record<string, unknown> }> };
  };
  return (await new PDFParse({ data: pdf }).getInfo()).info;
}

describe('writePdfInfoDictionary', () => {
  it('puts the pack\'s own title, author and subject into a Chromium PDF', async () => {
    // The state the rendered board pack shipped in: `pdfinfo` read
    // `Custom Metadata: no` and `Creator: Chromium`.
    const before = await readInfo(chromiumPdf);
    expect(before.Title).toBeUndefined();
    expect(before.Creator).toBe('Chromium');

    const after = await readInfo(writePdfInfoDictionary(chromiumPdf, METADATA));
    expect(after.Title).toBe(METADATA.title);
    expect(after.Author).toBe(METADATA.author);
    expect(after.Subject).toBe(METADATA.subject);
    expect(after.Creator).toBe(METADATA.creator);
  }, 120_000);

  it('keeps the keys it does not set, and the pages', async () => {
    // An incremental update must not cost the document anything it had. The
    // producer is Skia's own claim about what wrote the page content and stays
    // true of it.
    const written = writePdfInfoDictionary(chromiumPdf, METADATA);
    const after = await readInfo(written);
    expect(after.Producer).toBe((await readInfo(chromiumPdf)).Producer);
    expect(after.CreationDate).toBe((await readInfo(chromiumPdf)).CreationDate);

    // The original bytes are a prefix of the result: nothing was rewritten.
    expect(written.subarray(0, chromiumPdf.length).equals(chromiumPdf)).toBe(true);
  }, 120_000);

  it('leaves a file it does not understand exactly as it found it', () => {
    // A cross-reference STREAM cannot take a classic xref section appended to
    // it. Returning the bytes unchanged is the whole point: a metadata gap
    // must not become a PDF outage on the transport production falls back to.
    const notAPdf = Buffer.from('%PDF-1.7\nnothing this writer understands\n', 'latin1');
    expect(writePdfInfoDictionary(notAPdf, METADATA).equals(notAPdf)).toBe(true);
  });

  it('encodes a name a literal string cannot carry', () => {
    // A literal `(Ndzinga — Café)` is read byte-by-byte as PDFDocEncoding and
    // comes back as mojibake. UTF-16BE behind a byte-order mark is the only
    // encoding a PDF text string has for it.
    expect(pdfString('Plain (Pty) Ltd')).toBe('(Plain \\(Pty\\) Ltd)');
    expect(pdfString('a\\b')).toBe('(a\\\\b)');
    expect(pdfString('Café')).toMatch(/^<FEFF[0-9A-F]+>$/);
  });
});
