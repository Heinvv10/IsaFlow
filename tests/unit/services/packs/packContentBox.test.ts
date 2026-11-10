/**
 * THE PRINT CONTENT BOX FOLLOWS FROM THE PAPER AND THE MARGINS, CHECKED WITHOUT A BROWSER.
 *
 * `PRINT_CONTENT_PX`, `PRINT_CONTAINER_PX` and `PRINT_CONTENT_HEIGHT_PX` (`packTextMetrics.ts`) were measured in
 * production's Gotenberg image and in Playwright's PDF (`tests/unit/print*` / `printParity/packPrintContentWidth`),
 * under A4 and the margins the transports pass (`PDF_MARGIN_MM`). They no longer read `PDF_MARGIN_MM`, so this holds
 * them to it here: a margin change fails in the unit run, not only in a browser test.
 *  - the widths are A4 less the side margins, rounded up to a whole pixel (174mm is 657.64px, lines break at 658;
 *    261mm is 986.46px, at 987); a container query reads 1/64px more;
 *  - the heights are A4 less the top and bottom margins, plus what Chromium's page box adds, pinned to the measurement
 *    (255mm is 963.78px, a sheet holds 966: 2.2205px more; 168mm is 634.96px, it holds 637: 2.0394px more). No closed
 *    form for that was found, so the margins and the paper they were measured under are pinned with them: change
 *    either and re-measure.
 */
import { describe, expect, it } from 'vitest';
import { PDF_MARGIN_MM } from '@/lib/pdf/pdfTransport';
import {
  PRINT_CONTAINER_PX, PRINT_CONTENT_HEIGHT_PX, PRINT_CONTENT_PX, type PageOrientation,
} from '@/modules/accounting/services/packs/pages/packTextMetrics';

const A4_MM = { portrait: { width: 210, height: 297 }, landscape: { width: 297, height: 210 } } as const;
const px = (mm: number): number => (mm * 96) / 25.4;
/** The margins the measured box was printed under. */
const MEASURED_UNDER = { top: 20, bottom: 22, left: 18, right: 18 } as const;
const ORIENTATIONS: readonly PageOrientation[] = ['portrait', 'landscape'];

describe('the print content box', () => {
  it('was measured under the margins the transports pass: a margin change must be re-measured', () => {
    expect(PDF_MARGIN_MM, 'PDF_MARGIN_MM moved: re-measure PRINT_CONTENT_PX and PRINT_CONTENT_HEIGHT_PX (printParity/packPrintContentWidth)').toEqual(MEASURED_UNDER);
  });

  it.each(ORIENTATIONS)('%s: lines break at A4 less the side margins rounded up to a pixel, and a container query reads 1/64px more', (o) => {
    const width = px(A4_MM[o].width - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right);
    expect(PRINT_CONTENT_PX[o]).toBe(Math.ceil(width));
    expect(PRINT_CONTAINER_PX[o]).toBe(PRINT_CONTENT_PX[o] + 1 / 64);
  });

  it.each([['portrait', 2.2205], ['landscape', 2.0394]] as const)('%s: a sheet holds A4 less the top and bottom margins, and the %spx Chromium adds (pinned)', (o, adds) => {
    const height = px(A4_MM[o].height - PDF_MARGIN_MM.top - PDF_MARGIN_MM.bottom);
    expect(PRINT_CONTENT_HEIGHT_PX[o] - height).toBeCloseTo(adds, 4);
  });
});
