/**
 * PLAYWRIGHT'S OWN PDF PRINTS A PAGE'S CONTENT IN THE SAME BOX AS PRODUCTION (`PRINT_CONTENT_PX` x
 * `PRINT_CONTENT_HEIGHT_PX`), portrait and landscape, by the three measurements `pageBoxProblems` takes: so a test that
 * counts the sheets of a Playwright PDF counts what production prints. (Production's own is
 * `tests/unit/printParity/packPrintContentWidth.test.ts`, on velo.)
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { PDF_MARGIN_MM, mm } from '@/lib/pdf/pdfTransport';
import { PRINT_CONTENT_HEIGHT_PX, PRINT_CONTENT_PX, type PageOrientation } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { pageBoxProblems } from '../printParity/contentWidth';
import { servedPage } from '../printParity/gotenbergParity';
import { launchPrintChromium } from './printChromium';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

it.each(['portrait', 'landscape'] as const)('%s: Playwright\'s PDF breaks lines, reads its container and spills where the constants say', async (orientation: PageOrientation) => {
  const print = async (html: string, fonts: Parameters<typeof servedPage>[2]): Promise<Buffer> => {
    const page = await servedPage(browser, html, fonts, 1000);
    try {
      return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: mm(PDF_MARGIN_MM.top), bottom: mm(PDF_MARGIN_MM.bottom), left: mm(PDF_MARGIN_MM.left), right: mm(PDF_MARGIN_MM.right) } }));
    } finally {
      await page.close();
    }
  };
  expect(await pageBoxProblems(browser, print, orientation, PRINT_CONTENT_PX[orientation], PRINT_CONTENT_HEIGHT_PX[orientation])).toEqual([]);
}, 300_000);
