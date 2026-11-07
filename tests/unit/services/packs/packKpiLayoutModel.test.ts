/**
 * THE KPI MODEL CHARGES A TILE'S LINES AT THE NEVER-SHORT WIDTH OF THE WHOLE LINE, AND NOTHING NARROWER.
 *
 * `packGlyphRuler.runPx` rounds a width up to Chromium's 1/64px unit and adds one unit more: the shaping model is a unit
 * off Chromium either way on some strings, and the unit is what keeps it never short. The Chromium proof over the grid
 * is `tests/unit/print/packKpiLayout.test.ts`; this pins the model's own boundary without a browser, at the exact
 * width `textPx` gives the whole line: a column that width sets it on one line, a column 1/128px narrower on two. A
 * model that drops the unit (fits it in the narrower column) or sums the line piece by piece (each piece's rounding:
 * wraps it in the exact column) goes red here. A column a figure holds open is that figure's never-short width.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { DELTA_CUE_PX, deltaText, KPI_FIGURE_MAX_PT, kpiColumnMinPx, kpiFit, labelMarkPx, type KpiTile } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { ptToPx, textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { kpiColumnsPx, kpiTileMm } from '@/modules/accounting/services/packs/pages/packKpiLayout';
import { reasonPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
import { input, type Shape } from './fixtures/packGridInputs';

const SCALE = "R'000" as const;
const HAIR = 1 / 128;
/** `.pack-kpi-label` / `.pack-kpi-delta`: one line of 12pt leading. `.pack-kpi-unavailable`: 14pt. */
const LABEL_LINE_MM = 4.24;
const REASON_LINE_MM = 4.94;

function tiles(shape: Shape): KpiTile[] {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const page = buildBoardPackPages(input(shape)).pages.find((p) => p.navLabel === 'Highlights')!;
  const block = page.blocks.find((b) => b.kind === 'kpiTiles')!;
  if (block.kind !== 'kpiTiles') throw new Error('no tiles');
  return block.tiles;
}

const DEMO: Shape = { tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1, plug: 0.2, sg: [-1, 1, -1, 1] };
const NET_DEBIT: Shape = { tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 300000, plug: 0.05, sg: [-1, -1, 1, 1] };
const plain = (text: string): number => textPx(text, 12, 400);

describe('a tile line at the edge of its column', () => {
  const all = [...tiles(DEMO), ...tiles(NET_DEBIT)];
  /** One part of the tile alone: the others are a one-letter label, a figure, no delta and no sparkline. */
  const alone = (tile: KpiTile, part: Partial<KpiTile>): KpiTile => ({ ...tile, label: 'X', trendFootnote: null, delta: null, sparklineSvg: null, ...part });

  it('a delta line (its arrow cue, a space, the words) fits the exact width of the whole line, and no narrower', () => {
    const source = all.find((t) => t.delta !== null)!;
    const tile = alone(source, { delta: source.delta, figure: { ...source.figure, value: source.figure.value ?? 1 } });
    const whole = DELTA_CUE_PX + plain(' ') + plain(deltaText(tile));
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a label and its footnote mark fit the exact width of the two, and no narrower', () => {
    const source = all.find((t) => t.trendFootnote != null && t.label.includes(' '))!;
    const tile = alone(source, { label: source.label, trendFootnote: source.trendFootnote, figure: { ...source.figure, value: source.figure.value ?? 1 } });
    const whole = plain(tile.label) + labelMarkPx(tile.trendFootnote);
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a not-meaningful reason fits the exact width of the whole reason, and no narrower', () => {
    const source = all.find((t) => t.figure.value === null && (t.figure.unavailable ?? '').includes(' '))!;
    const tile = alone(source, {});
    const whole = reasonPx(tile.figure.unavailable ?? '');
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(REASON_LINE_MM, 6);
  });
});

describe('a column a figure holds open', () => {
  it('is the figure\'s never-short width, to the unit', () => {
    const row = tiles(NET_DEBIT);
    const fit = kpiFit(row, SCALE, 'portrait');
    const mins = kpiColumnMinPx(row, SCALE, fit.px ?? ptToPx(KPI_FIGURE_MAX_PT));
    const columns = kpiColumnsPx(row, SCALE, 'portrait');
    const share = Math.min(...columns);
    const frozen = columns.map((c, i) => [c, mins[i]!] as const).filter(([c]) => c > share);
    expect(frozen.length).toBeGreaterThan(0);
    frozen.forEach(([c, min]) => expect(c).toBe(min));
  });
});
