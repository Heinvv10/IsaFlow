/**
 * NO ELEMENT OF ANY PAGE PASSES THE SHEET'S RIGHT EDGE, AT ANY SCALE FROM 1 TO 300 000.
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
import { chromium } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { page6Input } from '../services/packs/fixtures/page6Shapes';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

const SCALES = [1, 30, 300, 1000, 3000, 10_000, 30_000, 100_000, 300_000];

describe.each(SCALES)('the demo company at k=%i', (k) => {
  it.each([['profit', false], ['loss', true]] as const)('%s: twelve sheets and nothing past the right edge on any page', async (unused, loss) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const doc = buildBoardPackPages(page6Input({ k, negative: false, loss, plug: 0, sg: [1, 1, 1, 1] }));
      const printed = await printBoardPack(doc, browser);
      expect(printed.sheets, 'a page took a second sheet').toBe(doc.pages.length);
      expect(printed.overflow, 'content runs past the right edge').toEqual([]);
      expect(printed.heights.filter((h) => h.overMm > 0.2).map((h) => [h.id, h.overMm]), 'a page runs past its sheet').toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});
