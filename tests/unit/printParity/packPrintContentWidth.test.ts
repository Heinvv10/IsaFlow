/**
 * PRODUCTION PRINTS A PAGE'S CONTENT IN `PRINT_CONTENT_PX` x `PRINT_CONTENT_HEIGHT_PX`: measured in the PDF the
 * production Gotenberg image prints, portrait and landscape, by where a line wraps, by a container query and by where a
 * line spills to a second sheet (`contentWidth.pageBoxProblems`). Velo only (`paritySkip.ts` says when it may skip).
 * RE-RUN THIS whenever the gotenberg image or the pack's fonts change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { PRINT_CONTENT_HEIGHT_PX, PRINT_CONTENT_PX, type PageOrientation } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { launchPrintChromium } from '../print/printChromium';
import { pageBoxProblems } from './contentWidth';
import { gotenbergPdf, startGotenberg, type Gotenberg } from './gotenbergParity';
import { paritySkip } from './paritySkip';

const skip = paritySkip();
let gotenberg: Gotenberg | undefined;
let browser: Browser | undefined;
beforeAll(async () => {
  if (skip !== null) return;
  browser = await launchPrintChromium();
  gotenberg = await startGotenberg();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  gotenberg?.stop();
});

describe.skipIf(skip !== null)(`the box production prints a page's content in${skip === null ? '' : ` (SKIPPED: ${skip})`}`, () => {
  it.each(['portrait', 'landscape'] as const)('%s: the image\'s PDF breaks lines, reads its container and spills where the constants say', async (orientation: PageOrientation) => {
    const print = (html: string, fonts: Parameters<typeof gotenbergPdf>[2]) => gotenbergPdf(gotenberg!, html, fonts);
    expect(await pageBoxProblems(browser!, print, orientation, PRINT_CONTENT_PX[orientation], PRINT_CONTENT_HEIGHT_PX[orientation])).toEqual([]);
  }, 300_000);
});
