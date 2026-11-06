/**
 * PLAYWRIGHT'S OWN PDF IS 658px WIDE (987 landscape), 25/64px NARROWER THAN PRODUCTION'S (`PRINT_CONTENT_PX`): its
 * content box is snapped to whole pixels. The tests that count the sheets of a Playwright PDF print 0.39px narrower
 * than production does (the side that wraps more and prints taller); the models and the DOM harnesses lay out at
 * `PRINT_CONTENT_PX`. A line wraps in Playwright's PDF exactly where it wraps in a page laid out at these widths.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import { PRINT_CONTENT_PX, type PageOrientation } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { candidateBody, candidates, domFlip, flipDocument, pdfFlip } from '../printParity/contentWidth';
import { withPdfFile } from '../printParity/gotenbergParity';
import { launchPrintChromium } from './printChromium';

const PLAYWRIGHT_PDF_PX: Readonly<Record<PageOrientation, number>> = { portrait: 658, landscape: 987 };

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

it.each(['portrait', 'landscape'] as const)('%s: Playwright\'s PDF wraps where a page 658 (987) wide does, 25/64px before production', async (orientation: PageOrientation) => {
  expect(PRINT_CONTENT_PX[orientation] - PLAYWRIGHT_PDF_PX[orientation]).toBe(25 / 64);
  const flip = await domFlip(browser, PLAYWRIGHT_PDF_PX[orientation]);
  const widths = candidates(flip - 8 / 64, 17);
  const page = await browser.newPage();
  try {
    await page.emulateMedia({ media: 'print' });
    await page.setContent(flipDocument(candidateBody(widths, orientation)).html);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom), left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right) } });
    expect(withPdfFile(Buffer.from(pdf), (file) => pdfFlip(file, widths))).toBe(flip);
  } finally {
    await page.close();
  }
}, 120_000);
