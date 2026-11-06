/**
 * PRODUCTION PRINTS A PAGE'S CONTENT `PRINT_CONTENT_PX` WIDE: a line wraps in the PDF the production Gotenberg image
 * prints exactly where it wraps in a page laid out at that width, portrait and landscape, to 1/64px (`contentWidth.ts`
 * says how). Velo only (the image is there); elsewhere skipped, and says why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { PRINT_CONTENT_PX, type PageOrientation } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { launchPrintChromium } from '../print/printChromium';
import { candidateBody, candidates, domFlip, flipDocument, pdfFlip } from './contentWidth';
import { gotenbergPdf, parityUnavailable, startGotenberg, withPdfFile, type Gotenberg } from './gotenbergParity';

const unavailable = parityUnavailable();
let gotenberg: Gotenberg | undefined;
let browser: Browser | undefined;
beforeAll(async () => {
  if (unavailable !== null) return;
  browser = await launchPrintChromium();
  gotenberg = await startGotenberg();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  gotenberg?.stop();
});

describe.skipIf(unavailable !== null)(`the width production prints at${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it.each(['portrait', 'landscape'] as const)('%s: Gotenberg\'s PDF wraps exactly where a page PRINT_CONTENT_PX wide does', async (orientation: PageOrientation) => {
    const flip = await domFlip(browser!, PRINT_CONTENT_PX[orientation]);
    const widths = candidates(flip - 8 / 64, 17);
    const { html, fonts } = flipDocument(candidateBody(widths, orientation));
    const printed = withPdfFile(await gotenbergPdf(gotenberg!, html, fonts), (file) => pdfFlip(file, widths));
    expect(printed, `laid out at ${PRINT_CONTENT_PX[orientation]}px the line flips at ${flip}px`).toBe(flip);
  }, 300_000);
});
