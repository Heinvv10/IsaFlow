/**
 * THE FIT MODEL'S KPI BLOCK IS CHROMIUM'S, ROW BY ROW.
 *
 * `packKpiLayout.ts` says how wide each of the four columns is and how tall each row of tiles and the block are.
 * This prints a stratified sample of packs (net-debit and ordinary revenue, profit and loss, with and without a
 * budget, a prior and trend panels, scales 1 to 3e8) and holds every KPI block to what Chromium made of it: columns
 * within a pixel, rows and the block never short and never far over.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { kpiBlockMm, kpiColumnsPx, kpiTileMm } from '@/modules/accounting/services/packs/pages/packKpiLayout';
import { input, type Shape } from '../services/packs/fixtures/packGridInputs';
import { measureKpiBlocks } from './measureKpi';
import { printBoardPack } from './renderPackPdf';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 180_000);
afterAll(async () => { await browser?.close(); });

/** Rounding: the constants are the measured leadings rounded up to the hundredth. */
const SLACK = 0.02;
/**
 * The most the model may read over the print. Its only excess is the leadings rounded up to the hundredth (12pt is
 * 4.233mm, charged 4.24; 25pt 8.819, charged 8.83) and the sparkline's 0.01mm, a few hundredths a row: over all
 * 11,520 packs of the adversarial grid the block read 0.018 to 0.117mm over Chromium's. A line or a gap too many is
 * 4mm or 1mm; a leading off by 0.05mm is 0.1mm on a two-row block. Both go red here.
 */
const MOST_OVER = 0.15;
const SHAPES: Shape[] = [];
for (const k of [1, 30, 1000, 30000, 300000, 3e7, 2.7e8]) for (const negative of [false, true]) for (const loss of [false, true])
  for (const sg of [[1, 1, 1, 1], [-1, -1, 1, 1], [1, -1, -1, 1]]) for (const tr of ['demo', 'none'] as const)
    for (const [budget, prior] of [[true, true], [false, false]] as const) SHAPES.push({ k, negative, loss, plug: 0.05, sg, budget, prior, tr });

describe('the KPI block of a stratified sample of packs', () => {
  it(`${SHAPES.length} packs: columns within 1px, rows and the block never short, and within ${MOST_OVER}mm`, async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const wrong: string[] = [];
    let blocks = 0;
    let shortest = Infinity;
    let tallest = -Infinity;
    let squeezed = 0;
    for (const shape of SHAPES) {
      let doc;
      try { doc = buildBoardPackPages(input(shape)); } catch (e) { if (e instanceof PackRefusal) continue; throw e; }
      const printed = await measureKpiBlocks(doc, browser);
      for (const page of doc.pages) {
        const real = printed.filter((b) => b.page === page.number);
        page.blocks.filter((b) => b.kind === 'kpiTiles').forEach((block, i) => {
          const r = real[i];
          if (r === undefined || block.kind !== 'kpiTiles') { wrong.push(`${JSON.stringify(shape)}: no printed block`); return; }
          blocks += 1;
          const scale = doc.numberConvention.scale;
          const columns = kpiColumnsPx(block.tiles, scale, page.orientation);
          const label = `${JSON.stringify(shape)} page ${page.number}`;
          columns.forEach((px, c) => { if (Math.abs(px - r.columnsPx[c]!) > 1) wrong.push(`${label} column ${c}: model ${px.toFixed(1)} vs ${r.columnsPx[c]!.toFixed(1)}`); });
          if (columns.some((px) => px < 100)) squeezed += 1;
          const model = kpiBlockMm(block.tiles, scale, page.orientation);
          const gap = model - r.heightMm;
          shortest = Math.min(shortest, gap);
          tallest = Math.max(tallest, gap);
          if (gap < -SLACK || gap > MOST_OVER) wrong.push(`${label} block: model ${model.toFixed(2)} vs ${r.heightMm.toFixed(2)}`);
          const rows = r.rowsMm.map((mm, row) => ({ mm, model: Math.max(...block.tiles.slice(row * 4, row * 4 + 4).map((t, j) => kpiTileMm(t, columns[j]!))) }));
          rows.forEach((row, n) => { if (row.model < row.mm - SLACK) wrong.push(`${label} row ${n}: model ${row.model.toFixed(2)} vs ${row.mm.toFixed(2)}`); });
        });
      }
    }
    expect(blocks).toBeGreaterThan(200);
    expect(squeezed, 'the sample must hold a squeezed column (a reason or a label holding its column open)').toBeGreaterThan(5);
    expect(wrong.slice(0, 12)).toEqual([]);
    process.stdout.write(`KPIGAP ${shortest.toFixed(3)} ${tallest.toFixed(3)} blocks=${blocks} squeezed=${squeezed}\n`);
  }, 1_800_000);
});

describe('the block as the page prints it (the adversary\'s two cases, measured in the page laid out at the print\'s width)', () => {
  it.each<[string, Shape]>([
    ['a reason in column 2 wraps one line fewer than a narrower page would set it (92 packs read 5mm tall)', { tr: 'none', budget: true, prior: true, negative: true, loss: true, k: 30000, plug: 0.05, sg: [-1, -1, 1, -1] }],
    ['a pack the model read 0.07mm short of the print', { tr: 'demo', budget: false, prior: false, negative: true, loss: false, k: 30000, plug: 0.2, sg: [-1, 1, -1, -1] }],
  ])('%s', async (unused, shape) => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const doc = buildBoardPackPages(input(shape));
    const i = doc.pages.findIndex((p) => p.navLabel === 'Highlights');
    const page = doc.pages[i]!;
    const block = page.blocks.find((b) => b.kind === 'kpiTiles')!;
    if (block.kind !== 'kpiTiles') throw new Error('no tiles');
    const model = kpiBlockMm(block.tiles, doc.numberConvention.scale, page.orientation);
    const out = await printBoardPack(doc, browser);
    const printed = out.heights[i]!.blocks.filter((b) => !b.what.startsWith('header') && !b.what.startsWith('ol.'))[page.blocks.indexOf(block)]!.mm;
    // `printBoardPack` reports a block's height to the tenth of a millimetre: half of that either way is rounding.
    expect(model - printed, `model ${model.toFixed(2)}mm, print ${printed}mm`).toBeGreaterThanOrEqual(-SLACK - 0.05);
    expect(model - printed, `model ${model.toFixed(2)}mm, print ${printed}mm`).toBeLessThanOrEqual(MOST_OVER + 0.05);
  }, 300_000);
});
