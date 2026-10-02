/**
 * THE SHARED SCALE HAS TO REACH THE PAPER.
 *
 * Page 10's four money panels are drawn on one y-domain, and the page says so
 * in its own caption. That was true in the SVG's user space — measured by
 * least squares over the plotted vertices, four px-per-unit agreeing to 1.0%
 * — and it was NOT true of the printed page: `.pack-chart-svg` took `flex: 1`
 * of whatever the caption left inside a fixed-height figure, so net profit's
 * two-line title gave it a 123.3px plot box against the other panels' 142.0px
 * and the same rand amount was painted 13.2% shorter. One domain, two scales,
 * under a sentence a reader can check.
 *
 * Both measurements were correct and they were of different things. This test
 * measures the one a director sees: `getScreenCTM`, which is the transform
 * Chromium will paint with — viewBox, `preserveAspectRatio` and box size
 * together — in the real print harness, at A4, with the real IBM Plex faces.
 *
 * The fixture is `liveDemoInput` because its net profit panel is the one whose
 * caption wraps: it carries the credit-month clause, which is the sentence
 * that made this visible. A fixture with six one-line titles cannot fail.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { measurePaintedPanels, withChromium } from './renderPackPdf';
import { liveDemoInput } from '../services/packs/fixtures/liveDemoBoardPack';

describe('page 10, on paper', () => {
  it('paints every panel at one scale, whatever its caption costs', async () => {
    const panels = await withChromium((browser) =>
      measurePaintedPanels(buildBoardPackPages(liveDemoInput), browser));

    // Four, not six: this fixture's gross margin and debtor days are not
    // meaningful in every month, so those two panels are not drawn at all —
    // which is the money group on its own, and the group the claim is about.
    expect(panels.length).toBeGreaterThanOrEqual(4);

    // The fixture must still contain the case: a caption that wraps. Without
    // this the assertion below is vacuous the day someone shortens a title.
    const tallest = Math.max(...panels.map((p) => p.title.length));
    expect(tallest).toBeGreaterThan(80);

    const scales = panels.map((p) => p.pxPerUserUnit);
    const spread = (Math.max(...scales) - Math.min(...scales)) / Math.max(...scales);
    // Sub-pixel, not "close enough": the boxes are identical by construction
    // now, so anything above rounding means a caption is eating a plot again.
    expect(spread, `painted scales: ${scales.join(', ')}`).toBeLessThan(0.001);

    const boxes = panels.map((p) => p.plotPx);
    expect(Math.max(...boxes) - Math.min(...boxes)).toBeLessThan(0.5);
  }, 120_000);
});
