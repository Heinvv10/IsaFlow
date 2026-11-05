/**
 * `kpiColumnWidthsMm`: the widths of a KPI tile row's four columns where the figures stretch them (the stylesheet's
 * `minmax(auto, 1fr)` columns), which the height model reads so a stretched column is charged the taller sparkline
 * it prints. Null for a row nothing stretches: the model then charges it as it always has.
 */
import { describe, expect, it } from 'vitest';
import { kpiColumnWidthsMm } from '@/modules/accounting/services/packs/pages/packKpiRowFit';
import { kpiTileHeight } from '@/modules/accounting/services/packs/pages/packKpiTileHeight';
import { PAGE_WIDTH_MM } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import type { PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoWithoutBudget, money, withWidenedKpi } from './fixtures/widenedFigures';

const ROOM = PAGE_WIDTH_MM.portrait - 3 * 8;

const kpiTiles = (digits: number): PackKpiTile[] => {
  const { doc } = withWidenedKpi(demoWithoutBudget(), digits);
  const block = doc.pages[2]!.blocks.find((b) => b.kind === 'kpiTiles');
  if (block?.kind !== 'kpiTiles') throw new Error('no KPI block');
  return block.tiles;
};

describe('kpiColumnWidthsMm', () => {
  it('is null for the demo company\'s tiles (every column a quarter): the height is what it always was', () => {
    expect(kpiColumnWidthsMm(kpiTiles(6))).toBeNull();
  });

  it('shares the room between four columns, a wide figure keeping its width and squeezing the others', () => {
    const base = kpiTiles(6);
    const tiles = [{ ...base[0]!, figure: { ...base[0]!.figure, value: money(11) } }, ...base.slice(1)];
    const widths = kpiColumnWidthsMm(tiles)!;
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(ROOM, 6);
    expect(Math.max(...widths)).toBeGreaterThan(ROOM / 4);
    expect(Math.min(...widths)).toBeLessThan(ROOM / 4);
  });
});

describe('kpiTileHeight', () => {
  const tiles = kpiTiles(6);
  const withDelta = tiles.find((t) => t.delta !== null && t.sparklineSvg !== null)!;

  it('with no column it is the height every pack has always been charged', () => {
    expect(kpiTileHeight(withDelta)).toBeCloseTo(kpiTileHeight(withDelta, undefined), 10);
  });

  it('a wide column is charged what a quarter is (its sparkline is capped at the 33mm already charged)', () => {
    expect(kpiTileHeight(withDelta, 60)).toBeCloseTo(kpiTileHeight(withDelta), 6);
  });

  it('a column squeezed so far that its delta line must wrap again is charged the extra line, never less than before', () => {
    const quarter = kpiTileHeight(withDelta);
    expect(kpiTileHeight(withDelta, 30)).toBeGreaterThanOrEqual(quarter);
    expect(kpiTileHeight(withDelta, 15)).toBeGreaterThan(quarter);
  });
});
