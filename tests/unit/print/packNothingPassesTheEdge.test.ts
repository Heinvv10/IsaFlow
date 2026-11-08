/**
 * NO ELEMENT OF ANY PAGE PASSES THE SHEET'S RIGHT EDGE, AT ANY SCALE FROM 1 TO 10 000 000.
 *
 * Page 3's KPI tiles ran past the right edge of the paper from a net profit of (13 350 000) (R'000)
 * on: `.pack-kpi-tiles` is `repeat(4, 1fr)` and its figures are `nowrap` 22pt, so the widest figure of
 * a column set the track and the four tracks outgrew the 174mm measure; where the tiles were
 * narrower than that, they still wrapped more delta lines than the model budgets and the page took a
 * thirteenth sheet. Content past the edge is not short, it is GONE, which no sheet count can see.
 * Page 6's eight-column table did the same at 300 000.
 *
 * The demo company's figures scaled by k, as profit and as loss, printed through the real print
 * stylesheet: twelve sheets, and `printBoardPack`'s per-page overflow (the page's scrollWidth against
 * its box, which counts any descendant that sticks out) empty on EVERY page, not only the page a
 * fix was written for.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { launchPrintChromium } from './printChromium';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { blockMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { page6Input } from '../services/packs/fixtures/page6Shapes';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const SCALES = [1, 1000, 10_000, 30_000, 100_000, 300_000, 1_000_000, 10_000_000];
/** The smallest a KPI figure or a table figure may be set (the stylesheet's floors). */
const KPI_FLOOR_PT = 12;
const TABLE_FLOOR_PT = 7.5;

describe.each(SCALES)('the demo company at k=%i', (k) => {
  it.each([
    ['profit', false, true], ['loss', true, true], ['profit, no budget', false, false], ['loss, no budget', true, false],
  ] as const)('%s: twelve sheets, nothing past the right edge on any page, figures at least legible, the KPI block never taller than modelled', async (unused, loss, budget) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const input = page6Input({ k, negative: false, loss, plug: 0, sg: [1, 1, 1, 1] });
      const doc = buildBoardPackPages(budget ? input : { ...input, set: { ...input.set, budget: null } });
      const printed = await printBoardPack(doc, browser);
      expect(printed.sheets, 'a page took a second sheet').toBe(doc.pages.length);
      expect(printed.overflow, 'content runs past the right edge').toEqual([]);
      expect(printed.heights.filter((h) => h.overMm > 0.2).map((h) => [h.id, h.overMm]), 'a page runs past its sheet').toEqual([]);
      expect(printed.figurePt.filter((f) => (f.kpi ?? KPI_FLOOR_PT) < KPI_FLOOR_PT || (f.table ?? TABLE_FLOOR_PT) < TABLE_FLOOR_PT),
        'a figure is set below the legibility floor').toEqual([]);
      // The height model matches the CSS for what this change touches: the KPI tile block is never charged
      // less than the browser lays it out (a stretched column is wider, so its sparkline is taller: the
      // stylesheet caps it at the 33mm the model charges). Block 0 of the DOM is the page header.
      const highlights = doc.pages[2]!;
      const tiles = highlights.blocks.findIndex((b) => b.kind === 'kpiTiles');
      const measured = printed.heights[2]!.blocks[tiles + 1]!.mm;
      expect(blockMm(highlights.blocks[tiles]!, 'portrait'), 'the KPI tile block is taller on paper than the height model says').toBeGreaterThanOrEqual(measured - 0.05);
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});
