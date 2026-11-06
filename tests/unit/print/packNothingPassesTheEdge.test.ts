/**
 * NO ELEMENT OF ANY PAGE PASSES THE SHEET'S RIGHT EDGE, AT ANY SCALE FROM 1 TO 3 000 000 (the behaviour-changing ones).
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
import { type FigureWeight, textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { blockMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { page6Input } from '../services/packs/fixtures/page6Shapes';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

// The scales where behaviour changes: nothing fitted (1), the tile row first overflows (30 000), a stretched
// column and the 8-column table at its tightest (300 000), and the floor close to binding (3 000 000).
const SCALES = [1, 30_000, 300_000, 3_000_000];
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
      // THE WIDTH MODEL IS EXACT: every printed figure's width is what `textPx` says at the size it was set at
      // (a cell with a mark carries a superscript the model charges separately, so it is not compared).
      const wrong = printed.figureEms
        .filter((f) => !f.hasMark)
        .map((f) => ({ ...f, model: textPx(f.text, f.fontPx, f.weight as FigureWeight) }))
        .filter((f) => Math.abs(f.model - f.widthPx) > 0.6)
        .map((f) => `${f.text} at ${f.fontPx.toFixed(2)}px: model ${f.model.toFixed(1)}px, laid out ${f.widthPx.toFixed(1)}px`);
      expect(wrong, 'the width model disagrees with the printed figures').toEqual([]);
      // Every KPI block on every page (today only page 3 carries one), not just the first.
      doc.pages.forEach((pg, index) => {
        pg.blocks.forEach((block, bi) => {
          if (block.kind !== 'kpiTiles') return;
          const measured = printed.heights[index]!.blocks[bi + 1]!.mm;
          expect(blockMm(block, 'portrait'), `${pg.navLabel}: the KPI tile block is taller on paper than the height model says`).toBeGreaterThanOrEqual(measured - 0.05);
        });
      });
    } finally {
      warn.mockRestore();
    }
  }, 300_000);
});

describe('the demo company at k=1 prints its figures at their ceiling, as before', () => {
  it('KPI figures 22pt, table figures 9pt, on every page', async () => {
    const doc = buildBoardPackPages(page6Input({ k: 1, negative: false, loss: false, plug: 0, sg: [1, 1, 1, 1] }));
    const printed = await printBoardPack(doc, browser);
    for (const f of printed.figurePt) {
      if (f.kpi !== null) expect(f.kpi, `${f.id} KPI figures`).toBeCloseTo(22, 1);
      if (f.table !== null) expect(f.table, `${f.id} table figures`).toBeCloseTo(9, 1);
    }
    expect(printed.figurePt.some((f) => f.kpi !== null) && printed.figurePt.some((f) => f.table !== null)).toBe(true);
  }, 300_000);
});

describe('figures at the scales where the budget columns can no longer be set', () => {
  it.each([[20_000_000, true], [26_000_000, true], [30_000_000, false], [238_000_000, false], [1_000_000_000, false]] as const)(
    'k=%i: the pack is built, the Budget columns are %s, and every page prints inside the sheet at figures no smaller than the floor',
    async (k, budgetKept) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      try {
        const doc = buildBoardPackPages(page6Input({ k, negative: false, loss: false, plug: 0, sg: [1, 1, 1, 1] }));
        const table = doc.pages.find((p) => p.navLabel === 'Income statement')!.blocks.find((b) => b.kind === 'table');
        expect(table?.kind === 'table' && table.table.columns.includes('budget')).toBe(budgetKept);
        const printed = await printBoardPack(doc, browser);
        expect(printed.overflow).toEqual([]);
        expect(printed.sheets).toBe(doc.pages.length);
        expect(printed.figurePt.filter((f) => (f.kpi ?? KPI_FLOOR_PT) < KPI_FLOOR_PT || (f.table ?? TABLE_FLOOR_PT) < TABLE_FLOOR_PT)).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    }, 300_000);
});
