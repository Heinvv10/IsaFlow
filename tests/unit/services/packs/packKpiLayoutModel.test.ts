/**
 * THE KPI MODEL FITS A TILE'S LINE AS CHROMIUM'S LINE BREAKER DOES: EACH BOX'S EXACT SUM FLOORED TO THE UNIT.
 *
 * Whether a line holds its words is decided on the whole line's exact advance sum, floored to Chromium's 1/64px unit
 * (`textFitPx`, `reasonFitPx`, `labelMarkFitPx`; the delta's arrow cue its own box at the width Chromium sets it). The
 * Chromium proof is `tests/unit/print/packLineFit.test.ts` and, over packs, `packKpiLayout.test.ts`; this pins the
 * model's own boundary without a browser: a column that width sets the line on one line, a column 1/128px narrower on
 * two. A model that fits on the never-short width (wraps it in the exact column) or sums the line piece by piece goes red
 * here. A column a figure holds open is that figure's never-short width (a width a column is sized by stays never short).
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { deltaText, KPI_FIGURE_MAX_PT, kpiColumnMinPx, kpiFit, labelMarkFitPx, type KpiTile } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { ptToPx, textFitPx, textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { AS_CHROMIUM_SETS, CHROMIUM_LEAST } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { kpiColumnsPx, kpiTileMm, LABEL_LINE_MM, REASON_LINE_MM } from '@/modules/accounting/services/packs/pages/packKpiLayout';
import { reasonFitPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { input, type Shape } from './fixtures/packGridInputs';

const SCALE = "R'000" as const;
const HAIR = 1 / 128;

function tiles(shape: Shape): KpiTile[] {
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const page = buildBoardPackPages(input(shape)).pages.find((p) => p.navLabel === 'Highlights')!;
  const block = page.blocks.find((b) => b.kind === 'kpiTiles')!;
  if (block.kind !== 'kpiTiles') throw new Error('no tiles');
  return block.tiles;
}

const DEMO: Shape = { tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1, plug: 0.2, sg: [-1, 1, -1, 1] };
const NET_DEBIT: Shape = { tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 300000, plug: 0.05, sg: [-1, -1, 1, 1] };
const plain = (text: string): number => textFitPx(text, 12, 400);
const CUE = Math.max(...['\u2191', '\u2193', '\u2192'].map((arrow) => textPx(arrow, ptToPx(7), 400, false, AS_CHROMIUM_SETS)));

describe('a tile line at the edge of its column', () => {
  const all = [...tiles(DEMO), ...tiles(NET_DEBIT)];
  /** One part of the tile alone: the others are a one-letter label, a figure, no delta and no sparkline. */
  const alone = (tile: KpiTile, part: Partial<KpiTile>): KpiTile => ({ ...tile, label: 'X', trendFootnote: null, delta: null, sparklineSvg: null, ...part });

  it('a delta line (its arrow cue, a space, the words) fits the exact width of the whole line, and no narrower', () => {
    const source = all.find((t) => t.delta !== null)!;
    const tile = alone(source, { delta: source.delta, figure: { ...source.figure, value: source.figure.value ?? 1 } });
    const whole = CUE + plain(` ${deltaText(tile)}`);
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a label and its footnote mark fit the exact width of the two, and no narrower', () => {
    const source = all.find((t) => t.trendFootnote != null && t.label.includes(' '))!;
    const tile = alone(source, { label: source.label, trendFootnote: source.trendFootnote, figure: { ...source.figure, value: source.figure.value ?? 1 } });
    const whole = plain(tile.label) + labelMarkFitPx(tile.trendFootnote);
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a line that ends at a soft hyphen is charged with the hyphen Chromium sets there', () => {
    const source = all.find((t) => t.figure.value !== null)!;
    const tile = alone(source, { label: 'Ab Cd\u00ADefghijklmnop' });
    // "Ab Cd-" fits a column exactly its width with the hyphen, and not 1/128px less (then "Cd-" and the rest wrap).
    const withHyphen = textPx('Ab Cd\u00AD', 12, 400, true);
    expect(kpiTileMm(tile, withHyphen - HAIR) - kpiTileMm(tile, withHyphen)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a not-meaningful reason fits the exact width of the whole reason, and no narrower', () => {
    const source = all.find((t) => t.figure.value === null && (t.figure.unavailable ?? '').includes(' '))!;
    const tile = alone(source, {});
    const whole = reasonFitPx(tile.figure.unavailable ?? '');
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(REASON_LINE_MM, 6);
  });
});

describe('a shared column', () => {
  it('is on Chromium\'s unit: the share left once every held-open column is the widest Chromium can set it, floored', () => {
    for (const shape of [DEMO, NET_DEBIT]) {
      const columns = kpiColumnsPx(tiles(shape), SCALE, 'portrait');
      const share = Math.min(...columns);
      expect(Number.isInteger(share * 64), `${share}`).toBe(true);
    }
  });
});

describe('a column a figure holds open', () => {
  it('is the narrowest Chromium can set the figure, to the unit (its exact width less its float noise, rounded up)', () => {
    const row = tiles(NET_DEBIT);
    const fit = kpiFit(row, SCALE, 'portrait');
    const mins = kpiColumnMinPx(row, SCALE, fit.px ?? ptToPx(KPI_FIGURE_MAX_PT), CHROMIUM_LEAST);
    const columns = kpiColumnsPx(row, SCALE, 'portrait');
    const share = Math.min(...columns);
    const frozen = columns.map((c, i) => [c, mins[i]!] as const).filter(([c]) => c > share);
    expect(frozen.length).toBeGreaterThan(0);
    frozen.forEach(([c, min]) => expect(c).toBe(min));
  });
});

describe('the sparkline the model sizes', () => {
  const withSparkline = [...tiles(DEMO), ...tiles({ ...DEMO, k: 300000 })].filter((t) => t.sparklineSvg !== null);

  it('is written by the chart renderer with a numeric width and height on its root <svg>, the only format the model reads', () => {
    expect(withSparkline.length).toBeGreaterThan(3);
    for (const tile of withSparkline) expect(String(tile.sparklineSvg)).toMatch(/^<svg width="\d+(?:\.\d+)?" height="\d+(?:\.\d+)?" /);
  });

  it('is charged at its own height over width, the column\'s width high', () => {
    const tile = withSparkline[0]!;
    const [, w, hgt] = /^<svg width="([\d.]+)" height="([\d.]+)"/.exec(String(tile.sparklineSvg))!;
    const without = kpiTileMm({ ...tile, sparklineSvg: null }, 100);
    const px = 25.4 / 96;
    // The sparkline as Chromium sets it, its height taken up to the 1/64px unit, and the tile's 1mm gap floored to it.
    expect(kpiTileMm(tile, 100) - without).toBeCloseTo((Math.ceil(100 * (Number(hgt) / Number(w)) * 64) / 64 + Math.floor((96 / 25.4) * 64) / 64) * px, 9);
  });

  it('is refused, not guessed at, where its root carries no width and height', () => {
    const tile = withSparkline[0]!;
    expect(() => kpiTileMm({ ...tile, sparklineSvg: '<svg viewBox="0 0 227 181"></svg>' as typeof tile.sparklineSvg }, 100)).toThrow(/sparkline SVG/);
  });
});

describe('a tile whose text the pack\'s faces do not set', () => {
  const tile = tiles(DEMO).find((t) => t.delta !== null)!;
  const reasonTile = [...tiles(DEMO), ...tiles(NET_DEBIT)].find((t) => t.figure.value === null)!;

  it.each([
    ['a Thai label', { label: 'รายได้จากการดำเนินงาน' }],
    ['a Devanagari label', { label: 'परिचालन राजस्व' }],
    ['an emoji in a label', { label: 'Revenue 📈' }],
    ['an Arabic delta basis', { delta: { ...tile.delta!, basis: 'الإيرادات التشغيلية' } }],
  ] as Array<[string, Partial<KpiTile>]>)('%s is refused: its fallback face\'s line box is taller than any the model charges', (_name, part) => {
    expect(() => kpiTileMm({ ...tile, ...part }, 150)).toThrow(PackRefusal);
  });

  it('a Tibetan not-meaningful reason is refused', () => {
    expect(() => kpiTileMm({ ...reasonTile, figure: { ...reasonTile.figure, unavailable: 'Not meaningful: ཀྵྐྵ བོད' } }, 150)).toThrow(PackRefusal);
  });

  it('text the faces set (Greek, Cyrillic, accented Latin, a non-breaking space) is charged, not refused', () => {
    expect(kpiTileMm({ ...tile, label: 'Ελληνικά Кириллица Ūňîčőđę ratio' }, 150)).toBeGreaterThan(0);
  });
});
