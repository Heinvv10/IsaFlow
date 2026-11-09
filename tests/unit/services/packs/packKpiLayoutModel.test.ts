/**
 * THE KPI MODEL FITS A TILE'S LINE AS CHROMIUM'S LINE BREAKER DOES: EACH BOX'S EXACT SUM FLOORED TO THE UNIT.
 *
 * Whether a line holds its words is decided on the whole line's exact advance sum, floored to Chromium's 1/64px unit
 * (every box on the line summed exactly and floored once with Chromium's noise margin, `fitUnitsPx`; the delta's arrow cue its own box at the width Chromium sets it). The
 * Chromium proof is `tests/unit/print/packLineFit.test.ts` and, over packs, `packKpiLayout.test.ts`; this pins the
 * model's own boundary without a browser: a column that width sets the line on one line, a column 1/128px narrower on
 * two. A model that fits on the never-short width (wraps it in the exact column) or sums the line piece by piece goes red
 * here. A column a figure holds open is that figure's never-short width (a width a column is sized by stays never short).
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { deltaText, KPI_FIGURE_MAX_PT, kpiColumnMinPx, kpiFit, labelMarkExactPx, type KpiTile } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { ptToPx, textExactPx, textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { AS_CHROMIUM_SETS, CHROMIUM_LEAST, CHROMIUM_MOST, fitUnitsPx } from '@/modules/accounting/services/packs/pages/packGlyphRuler';
import { kpiColumnsPx, kpiTileMm, LABEL_LINE_MM, REASON_LINE_MM } from '@/modules/accounting/services/packs/pages/packKpiLayout';
import { reasonExactPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
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
const exact = (text: string): number => textExactPx(text, 12, 400);
const CUE = Math.max(...['\u2191', '\u2193', '\u2192'].map((arrow) => textPx(arrow, ptToPx(7), 400, false, AS_CHROMIUM_SETS)));

describe('a tile line at the edge of its column', () => {
  const all = [...tiles(DEMO), ...tiles(NET_DEBIT)];
  /** One part of the tile alone: the others are a one-letter label, a figure, no delta and no sparkline. */
  const alone = (tile: KpiTile, part: Partial<KpiTile>): KpiTile => ({ ...tile, label: 'X', trendFootnote: null, delta: null, sparklineSvg: null, ...part });

  it('a delta line (its arrow cue, a space, the words) fits the exact width of the whole line, and no narrower', () => {
    const source = all.find((t) => t.delta !== null)!;
    const tile = alone(source, { delta: source.delta, figure: { ...source.figure, value: source.figure.value ?? 1 } });
    // The cue and the words summed exactly, floored once.
    const whole = fitUnitsPx(CUE + exact(` ${deltaText(tile)}`), 12);
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a label and its footnote mark fit the exact width of the two, and no narrower', () => {
    const source = all.find((t) => t.trendFootnote != null && t.label.includes(' '))!;
    const tile = alone(source, { label: source.label, trendFootnote: source.trendFootnote, figure: { ...source.figure, value: source.figure.value ?? 1 } });
    // The label and its mark summed exactly, floored once (each floored on its own reads a unit narrower).
    const whole = fitUnitsPx(exact(tile.label) + labelMarkExactPx(tile.trendFootnote), 12);
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a line that ends at a soft hyphen is charged with the hyphen Chromium sets there', () => {
    const source = all.find((t) => t.figure.value !== null)!;
    const tile = alone(source, { label: 'Ab Cd\u00ADefghijklmnop' });
    // "Ab Cd-" fits a column exactly its width with the hyphen, and not 1/128px less (then "Cd-" and the rest wrap).
    const withHyphen = fitUnitsPx(textExactPx('Ab Cd\u00AD', 12, 400, true), 12);
    expect(kpiTileMm(tile, withHyphen - HAIR) - kpiTileMm(tile, withHyphen)).toBeCloseTo(LABEL_LINE_MM, 6);
  });

  it('a not-meaningful reason fits the exact width of the whole reason, and no narrower', () => {
    const source = all.find((t) => t.figure.value === null && (t.figure.unavailable ?? '').includes(' '))!;
    const tile = alone(source, {});
    const whole = fitUnitsPx(reasonExactPx(tile.figure.unavailable ?? ''), ptToPx(11));
    expect(kpiTileMm(tile, whole - HAIR) - kpiTileMm(tile, whole)).toBeCloseTo(REASON_LINE_MM, 6);
  });
});

describe('a shared column', () => {
  it('is the share left of the sheet, floored to Chromium\'s unit: worked by hand for the demo row, no column held open', () => {
    // 658px less three 8mm gaps at Chromium's unit (30.236 floored to 30.234375): 567.296875, over four columns
    // 141.82421875, floored to the unit: 141.8125 (Chromium sets the first three at that, the last at 141.828125).
    const columns = kpiColumnsPx(tiles(DEMO), SCALE, 'portrait');
    expect(columns).toEqual([141.8125, 141.8125, 141.8125, 141.8125]);
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

  // The two bounds differ only where a column's widest run sits within Chromium's float noise of a grid point (one in
  // eight): there the column is the lower, so a line the model fits, Chromium fits. A label word too long for the share
  // holds the first column open, and is walked until its width lands there; a model that holds the column at the widest
  // Chromium can set it, or a narrowest bound rounded as the widest, goes red.
  it('where the narrowest and widest Chromium can set it differ, it is the narrowest, strictly below the widest', () => {
    const base = tiles(DEMO);
    let checked = 0;
    let belowRoundedUp = 0;
    for (let n = 0; n < 400 && (checked < 3 || belowRoundedUp < 1); n += 1) {
      const word = `Intercompanyrechargesreceivable${Array.from(String(n), (d) => 'aeilmnorst'[Number(d)]).join('')}`;
      const row = base.map((t, i) => (i === 0 ? { ...t, label: word, trendFootnote: null } : t));
      const fontPx = kpiFit(row, SCALE, 'portrait').px ?? ptToPx(KPI_FIGURE_MAX_PT);
      const least = kpiColumnMinPx(row, SCALE, fontPx, CHROMIUM_LEAST)[0]!;
      const most = kpiColumnMinPx(row, SCALE, fontPx, CHROMIUM_MOST)[0]!;
      const columns = kpiColumnsPx(row, SCALE, 'portrait');
      expect(columns[0], `${word} holds its column open`).toBeGreaterThan(Math.max(...columns.slice(1)));
      if (least === most) continue;
      checked += 1;
      expect(columns[0], word).toBe(least);
      expect(columns[0]!, word).toBeLessThan(most);
      // Where the exact sum sits just past a grid point, the narrowest is that grid point, a unit below the sum rounded
      // up: Chromium's noise can set it there.
      if (least < kpiColumnMinPx(row, SCALE, fontPx, AS_CHROMIUM_SETS)[0]!) belowRoundedUp += 1;
    }
    expect(checked, 'no held-open column whose bounds differ: the test is vacuous').toBeGreaterThanOrEqual(3);
    expect(belowRoundedUp, 'no held-open column whose narrowest bound is below its exact width rounded up').toBeGreaterThan(0);
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
    expect(String(tile.sparklineSvg)).toMatch(/^<svg width="227" height="181" /);
    const without = kpiTileMm({ ...tile, sparklineSvg: null }, 100);
    // Worked by hand. In a 100px column the 227 x 181 sparkline is 100 x 181 / 227 = 79.7357px; Chromium floors a
    // sparkline's height to its 1/64px unit (measured: in a 97.09375px column, 77.4196 is set at 77.40625), 79.734375, and
    // the model takes a unit up, 79.75px (5104/64); the tile's 1mm gap is 3.7795px, floored to 3.765625 (241/64). The
    // two are 83.515625px = 83.515625 x 25.4 / 96 = 22.09684245mm.
    expect(kpiTileMm(tile, 100) - without).toBeCloseTo(22.09684245, 7);
  });

  it('is refused, not guessed at, where its root carries no width and height', () => {
    const tile = withSparkline[0]!;
    expect(() => kpiTileMm({ ...tile, sparklineSvg: '<svg viewBox="0 0 227 181"></svg>' as typeof tile.sparklineSvg }, 100)).toThrow(PackRefusal);
  });
});

describe('a tile whose text the pack\'s faces do not set', () => {
  const tile = tiles(DEMO).find((t) => t.delta !== null)!;
  const reasonTile = [...tiles(DEMO), ...tiles(NET_DEBIT)].find((t) => t.figure.value === null)!;

  it.each([
    ['a Thai label', { label: 'รายได้จากการดำเนินงาน' }],
    ['a Devanagari label', { label: 'परिचालन राजस्व' }],
    ['an emoji in a label', { label: 'Revenue 📈' }],
    ['a private-use character in a label (one the ruler once read as a slash)', { label: 'Net\uE044profit' }],
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
