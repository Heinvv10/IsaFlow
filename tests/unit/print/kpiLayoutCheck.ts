/**
 * ONE PACK'S KPI BLOCKS AGAINST CHROMIUM'S: the check `packKpiLayout.test.ts` runs over a stratified sample and
 * `packKpiLayoutGrid.test.ts` over the whole adversarial grid.
 *
 * Columns within a pixel; every row and the block never short of Chromium's (no tolerance but float noise); the block
 * never more than `MOST_OVER` over, except in the band: a near tie where exactly one wrapped part of exactly one tile
 * sets exactly one line more than Chromium, and the block less that one line is back within bounds.
 */
import type { Browser } from 'playwright';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { KpiTile } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { stampFigureFits } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';
import {
  kpiBlockMm, kpiColumnBoundsPx, kpiTileLines, kpiTileMm, LABEL_LINE_MM, REASON_LINE_MM, type KpiTileLines,
} from '@/modules/accounting/services/packs/pages/packKpiLayout';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { input, type Shape } from '../services/packs/fixtures/packGridInputs';
import { measureKpiBlocks } from './measureKpi';

/** Never short: no tolerance. This is float noise in the millimetre arithmetic, a millionth of Chromium's 1/64px unit. */
export const NEVER_SHORT_EPS = 1e-9;
/**
 * The most the model may read over the print. Its leadings, gaps and the sparkline's cap are Chromium's own, to its
 * 1/64px unit; its one excess is the sparkline, taken a unit up at the widest its column can be (the figures' width
 * unit either way): thousandths of a millimetre a row. Over the grid's 11,520 packs (`packKpiLayoutGrid.test.ts`) the
 * block reads 0 to 0.025mm over. A line or a gap too many is 4mm or 1mm; a leading 0.05mm off is 0.1mm on two rows.
 */
export const MOST_OVER = 0.05;
/**
 * THE ONE WAY THE MODEL MAY READ A LINE TOO MANY: a near tie. Every width it charges is never short of Chromium's (the
 * shaping model's widths carry one 1/64px unit past Chromium's own, because it is a unit off either way on some
 * strings), and Chromium sets a line a unit or two wider than its column on one line ("Gross margin" and its mark,
 * 76.0625px in a 76.0469px column). Widened by this much (0.25px, 16 units, far less than any word), exactly one part
 * of one tile must lose exactly one line.
 */
export const BAND_PX = 0.25;

export interface Tally {
  wrong: string[]; blocks: number; shortest: number; tallest: number; squeezed: number;
  /** The blocks in the band, and how far each reads over the print (mm). */
  banded: string[]; bandedOverMm: number[];
  /** How far every block reads over the print (mm), in order. */
  overMm: number[];
}
export const tally = (): Tally => ({ wrong: [], blocks: 0, shortest: Infinity, tallest: -Infinity, squeezed: 0, banded: [], bandedOverMm: [], overMm: [] });

export const build = (shape: Shape): PackPagesDocument | null => {
  try { return buildBoardPackPages(input(shape)); } catch (e) { if (e instanceof PackRefusal) return null; throw e; }
};

/** The same pack with its KPI page turned (and its figures' fit decided again): the block as a landscape page sets it. */
export const turned = (doc: PackPagesDocument): PackPagesDocument => stampFigureFits({
  ...doc, pages: doc.pages.map((p) => (p.blocks.some((b) => b.kind === 'kpiTiles') ? { ...p, orientation: 'landscape' as const } : p)),
});

/** The height of the one line the model reads too many, or null where widening the columns changes anything else. */
export function oneLineTooMany(tiles: readonly KpiTile[], columns: readonly number[]): number | null {
  const changed: Array<{ part: keyof KpiTileLines; by: number }> = [];
  tiles.forEach((tile, i) => {
    const at = kpiTileLines(tile, columns[i % 4]!);
    const wider = kpiTileLines(tile, columns[i % 4]! + BAND_PX);
    (['label', 'reason', 'delta'] as const).forEach((part) => { if (at[part] !== wider[part]) changed.push({ part, by: at[part] - wider[part] }); });
  });
  if (changed.length !== 1 || changed[0]!.by !== 1) return null;
  return changed[0]!.part === 'reason' ? REASON_LINE_MM : LABEL_LINE_MM;
}

/** Every KPI block of `doc` against Chromium's: columns, rows and the block. */
export async function check(doc: PackPagesDocument, browser: Browser, label: string, t: Tally): Promise<void> {
  const printed = await measureKpiBlocks(doc, browser);
  for (const page of doc.pages) {
    const real = printed.filter((b) => b.page === page.number);
    page.blocks.filter((b) => b.kind === 'kpiTiles').forEach((block, i) => {
      const r = real[i];
      const where = `${label} page ${page.number} (${page.orientation})`;
      if (r === undefined || block.kind !== 'kpiTiles') { t.wrong.push(`${where}: no printed block`); return; }
      t.blocks += 1;
      const scale = doc.numberConvention.scale;
      const { line: columns, spark } = kpiColumnBoundsPx(block.tiles, scale, page.orientation);
      columns.forEach((px, c) => { if (Math.abs(px - r.columnsPx[c]!) > 1) t.wrong.push(`${where} column ${c}: model ${px.toFixed(1)} vs ${r.columnsPx[c]!.toFixed(1)}`); });
      if (columns.some((px) => px < 100)) t.squeezed += 1;
      const gap = kpiBlockMm(block.tiles, scale, page.orientation) - r.heightMm;
      t.shortest = Math.min(t.shortest, gap);
      t.overMm.push(gap);
      const line = gap > MOST_OVER ? oneLineTooMany(block.tiles, columns) : null;
      const banded = line !== null && gap - line >= -NEVER_SHORT_EPS && gap - line <= MOST_OVER;
      if (banded) { t.banded.push(where); t.bandedOverMm.push(gap); } else t.tallest = Math.max(t.tallest, gap);
      if (gap < -NEVER_SHORT_EPS || (gap > MOST_OVER && !banded)) t.wrong.push(`${where} block: model over by ${gap.toFixed(3)}mm`);
      const rows = r.rowsMm.map((mm, row) => ({ mm, model: Math.max(...block.tiles.slice(row * 4, row * 4 + 4).map((tile, j) => kpiTileMm(tile, columns[j]!, spark[j]!))) }));
      rows.forEach((row, n) => { if (row.model < row.mm - NEVER_SHORT_EPS) t.wrong.push(`${where} row ${n}: model ${row.model.toFixed(3)} vs ${row.mm.toFixed(3)}`); });
    });
  }
}
