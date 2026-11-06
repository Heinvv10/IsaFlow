/**
 * THE WIDTH CHROMIUM PRINTS A PAGE AT IS `PRINT_CONTENT_PX`.
 *
 * A line of two inline blocks and a space wraps once the first block is wide enough that the three no longer fit the
 * content box. Bisect the first block's width in a DOM laid out at `PRINT_CONTENT_PX` to find where it flips, then
 * print a PDF with the transports' paper and margins and check the line wraps in the PDF just past that width and not
 * just before it: the print's content box IS that wide (not the 657.6px of 174mm, not a 658px viewport).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import { PRINT_CONTENT_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const html = (first: number) => `<html><body style="margin:0;font:12px sans-serif"><div style="width:100%"><span id="a" style="display:inline-block;width:${first}px">AAAA</span> <span id="b" style="display:inline-block;width:1px">BBBB</span></div></body></html>`;

async function wrapsInDom(first: number, width: number): Promise<boolean> {
  const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
  try {
    await page.setContent(html(first));
    await page.emulateMedia({ media: 'print' });
    return await page.evaluate((w) => {
      document.documentElement.style.width = `${w}px`;
      return document.getElementById('b')!.getBoundingClientRect().top > document.getElementById('a')!.getBoundingClientRect().top + 1;
    }, width);
  } finally {
    await page.close();
  }
}

async function wrapsInPdf(first: number): Promise<boolean> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ pages: Array<{ text: string }> }> } };
  const page = await browser.newPage({ viewport: { width: 658, height: 1000 } });
  try {
    await page.setContent(html(first));
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ format: 'A4', margin: { top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom), left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right) } });
    return (await new PDFParse({ data: pdf }).getText()).pages[0]!.text.trim().includes('\n');
  } finally {
    await page.close();
  }
}

it('a line wraps in the PDF exactly where it wraps in a page laid out at PRINT_CONTENT_PX', async () => {
  let lo = 600;
  let hi = 700;
  for (let i = 0; i < 14; i += 1) {
    const mid = (lo + hi) / 2;
    if (await wrapsInDom(mid, PRINT_CONTENT_PX.portrait)) hi = mid; else lo = mid;
  }
  expect(await wrapsInPdf(lo - 0.3), 'just before the flip, one line').toBe(false);
  expect(await wrapsInPdf(lo + 0.3), 'just past it, two').toBe(true);
}, 300_000);
