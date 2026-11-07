/**
 * THE FIT MODEL'S KPI BLOCK IS CHROMIUM'S, ROW BY ROW.
 *
 * `packKpiLayout.ts` says how wide each of the four columns is and how tall each row of tiles and the block are.
 * This prints a stratified sample of packs (net-debit and ordinary revenue, profit and loss, with and without a
 * budget, a prior and trend panels, scales 1 to 3e8) and holds every KPI block to what Chromium made of it: columns
 * within a pixel, rows and the block never short and never far over. "What Chromium made of it" is production's
 * layout: text set at fractional advances (`launchPrintChromium`, as Gotenberg sets it) across the width production
 * prints a page at (`PRINT_CONTENT_PX`, by `measureKpiBlocks`), in portrait and, with the page turned, landscape.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { kpiBlockMm, kpiColumnsPx, kpiTileMm } from '@/modules/accounting/services/packs/pages/packKpiLayout';
import { input, type Shape } from '../services/packs/fixtures/packGridInputs';
import { measureKpiBlocks } from './measureKpi';
import { launchPrintChromium } from './printChromium';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 180_000);
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

interface Tally { wrong: string[]; blocks: number; shortest: number; tallest: number; squeezed: number }

/** Every KPI block of `doc` against Chromium's: columns, rows and the block. */
async function check(doc: PackPagesDocument, label: string, t: Tally): Promise<void> {
  const printed = await measureKpiBlocks(doc, browser);
  for (const page of doc.pages) {
    const real = printed.filter((b) => b.page === page.number);
    page.blocks.filter((b) => b.kind === 'kpiTiles').forEach((block, i) => {
      const r = real[i];
      const where = `${label} page ${page.number} (${page.orientation})`;
      if (r === undefined || block.kind !== 'kpiTiles') { t.wrong.push(`${where}: no printed block`); return; }
      t.blocks += 1;
      const scale = doc.numberConvention.scale;
      const columns = kpiColumnsPx(block.tiles, scale, page.orientation);
      columns.forEach((px, c) => { if (Math.abs(px - r.columnsPx[c]!) > 1) t.wrong.push(`${where} column ${c}: model ${px.toFixed(1)} vs ${r.columnsPx[c]!.toFixed(1)}`); });
      if (columns.some((px) => px < 100)) t.squeezed += 1;
      const model = kpiBlockMm(block.tiles, scale, page.orientation);
      const gap = model - r.heightMm;
      t.shortest = Math.min(t.shortest, gap);
      t.tallest = Math.max(t.tallest, gap);
      if (gap < -SLACK || gap > MOST_OVER) t.wrong.push(`${where} block: model ${model.toFixed(2)} vs ${r.heightMm.toFixed(2)}`);
      const rows = r.rowsMm.map((mm, row) => ({ mm, model: Math.max(...block.tiles.slice(row * 4, row * 4 + 4).map((tile, j) => kpiTileMm(tile, columns[j]!))) }));
      rows.forEach((row, n) => { if (row.model < row.mm - SLACK) t.wrong.push(`${where} row ${n}: model ${row.model.toFixed(2)} vs ${row.mm.toFixed(2)}`); });
    });
  }
}

const tally = (): Tally => ({ wrong: [], blocks: 0, shortest: Infinity, tallest: -Infinity, squeezed: 0 });
const build = (shape: Shape): PackPagesDocument | null => {
  try { return buildBoardPackPages(input(shape)); } catch (e) { if (e instanceof PackRefusal) return null; throw e; }
};
/** The same pack with its KPI page turned: the block as a landscape page would set it. */
const turned = (doc: PackPagesDocument): PackPagesDocument => ({
  ...doc, pages: doc.pages.map((p) => (p.blocks.some((b) => b.kind === 'kpiTiles') ? { ...p, orientation: 'landscape' as const } : p)),
});

describe('the KPI block of a stratified sample of packs', () => {
  it(`${SHAPES.length} packs: columns within 1px, rows and the block never short, and within ${MOST_OVER}mm`, async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const t = tally();
    for (const shape of SHAPES) {
      const doc = build(shape);
      if (doc !== null) await check(doc, JSON.stringify(shape), t);
    }
    expect(t.blocks).toBeGreaterThan(200);
    expect(t.squeezed, 'the sample must hold a squeezed column (a reason or a label holding its column open)').toBeGreaterThan(5);
    expect(t.wrong.slice(0, 12)).toEqual([]);
    process.stdout.write(`KPIGAP portrait ${t.shortest.toFixed(3)} ${t.tallest.toFixed(3)} blocks=${t.blocks} squeezed=${t.squeezed}\n`);
  }, 1_800_000);

  it(`the same packs with the page turned: landscape columns and heights, never short, within ${MOST_OVER}mm`, async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const t = tally();
    for (const shape of SHAPES) {
      const doc = build(shape);
      if (doc !== null) await check(turned(doc), JSON.stringify(shape), t);
    }
    expect(t.blocks).toBeGreaterThan(200);
    expect(t.wrong.slice(0, 12)).toEqual([]);
    process.stdout.write(`KPIGAP landscape ${t.shortest.toFixed(3)} ${t.tallest.toFixed(3)} blocks=${t.blocks} squeezed=${t.squeezed}\n`);
  }, 1_800_000);
});

describe('the adversary\'s two packs (#1196 round 1), at production\'s width', () => {
  it.each<[string, Shape]>([
    ['a reason in column 2 the 657.6px model wrapped a line more than the print (read 5mm tall)', { tr: 'none', budget: true, prior: true, negative: true, loss: true, k: 30000, plug: 0.05, sg: [-1, -1, 1, -1] }],
    ['a pack the 657.6px model read 0.07mm short of the print', { tr: 'demo', budget: false, prior: false, negative: true, loss: false, k: 30000, plug: 0.2, sg: [-1, 1, -1, -1] }],
  ])('%s', async (unused, shape) => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const t = tally();
    await check(buildBoardPackPages(input(shape)), JSON.stringify(shape), t);
    expect(t.blocks).toBe(1);
    expect(t.wrong).toEqual([]);
  }, 300_000);
});
