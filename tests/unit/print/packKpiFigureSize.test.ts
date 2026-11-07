/**
 * THE KPI FIGURE SIZE THE MODEL STATES IS THE SIZE CHROMIUM COMPUTES IN THE PRINT.
 *
 * `.pack-kpi-value` takes its size from `100cqw` of the tile row, and in production's print a container query reads
 * the content box 1/64px wider than the width lines break at (`PRINT_CONTAINER_PX`; measured in
 * `packPrintContentWidth.test.ts`). The model (`packKpiRowFit.kpiFigurePx`) sizes against that container width, so it
 * names the size Chromium computes, and the 1/64px font-size floor Chromium sets glyphs at (the adversary found the
 * gap moving that floor in 632 elements when the model used the line width). Every KPI row of every 127th pack of the
 * fitter grid (all twelve budget x prior x trend combinations), laid out at the container width.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { log } from '@/lib/logger';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { kpiFigurePx } from '@/modules/accounting/services/packs/pages/packKpiRowFit';
import { PRINT_CONTAINER_PX } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import { input, type Shape } from '../services/packs/fixtures/page6Grid';
import { allPage6Shapes } from '../services/packs/fixtures/page6Shapes';
import { flipDocument } from '../printParity/contentWidth';
import { servedPage } from '../printParity/gotenbergParity';
import { launchPrintChromium } from './printChromium';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const GRID: Shape[] = allPage6Shapes().flatMap((shape) => [true, false].flatMap((budget) => [true, false].flatMap((prior) => (['demo', 'none', 'zero'] as const)
  .map((tr) => ({ ...shape, budget, prior, tr })))));
const floor64 = (px: number): number => Math.floor(px * 64 + 1e-6) / 64;

it('every KPI row of every 127th grid pack: the model\'s size is the computed one, and its 1/64px floor too', async () => {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const wrong: string[] = [];
  const combos = new Set<number>();
  let rows = 0;
  let fitted = 0;
  for (let i = 0; i < GRID.length; i += 127) {
    let doc;
    try { doc = buildBoardPackPages(input(GRID[i]!)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
    combos.add(i % 12);
    const model = doc.pages.flatMap((page) => page.blocks.flatMap((b) => (b.kind === 'kpiTiles' ? [kpiFigurePx(b.tiles, page.orientation)] : [])));
    const { html, fonts } = flipDocument(renderToStaticMarkup(createElement(PackPagesView, { document: doc })));
    const page = await servedPage(browser, html, fonts, Math.ceil(PRINT_CONTAINER_PX.portrait) + 2);
    try {
      const computed = await page.evaluate((w) => {
        document.documentElement.style.width = `${w}px`;
        return Array.from(document.querySelectorAll('.pack-kpi-tiles')).map((row) => {
          const figure = row.querySelector('.pack-kpi-value');
          return figure === null ? null : Number.parseFloat(getComputedStyle(figure).fontSize);
        });
      }, PRINT_CONTAINER_PX.portrait);
      if (computed.length !== model.length) { wrong.push(`input ${i}: ${computed.length} rows printed, ${model.length} modelled`); continue; }
      computed.forEach((px, r) => {
        if (px === null) return;
        rows += 1;
        const m = model[r]!;
        if (px < 29.3) fitted += 1;
        // Chromium serialises a computed size to four decimals: equal to that, and on the same side of every 1/64px.
        const nearBoundary = Math.abs(m * 64 - Math.round(m * 64)) < 64 * 1e-4;
        if (Math.abs(px - m) > 1e-4 || (!nearBoundary && floor64(px) !== floor64(m))) wrong.push(`input ${i} row ${r}: model ${m}, computed ${px}`);
      });
    } finally {
      await page.close();
    }
  }
  expect(combos.size).toBe(12);
  expect(rows).toBeGreaterThan(200);
  expect(fitted, 'no row sized below 22pt by its container: the check would be vacuous').toBeGreaterThan(20);
  expect(wrong.slice(0, 10)).toEqual([]);
}, 900_000);
