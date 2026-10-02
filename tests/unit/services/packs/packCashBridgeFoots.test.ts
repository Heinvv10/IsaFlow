/**
 * PAGE 8, ON FIGURES SHAPED LIKE A LEDGER'S.
 *
 * Every fixture that exercised the cash bridge used round thousands, and on
 * those the bridge's residual is exactly zero. A real ledger's figures are
 * cents summed in floating point: 2 046 825.57 − 1 787 567.21 is not, in a
 * double, the 259 258.36 its three flows add to. The bridge compared that
 * difference with `!== 0`, so the moment the pack carried real cash flows it
 * would have drawn an "Unexplained movement" bar a ten-billionth of a rand
 * tall and captioned the page "… of the movement in cash is NOT explained".
 *
 * The four figures here foot to the cent, as `getReportPackInput` now
 * guarantees: opening + operating + investing + financing = closing.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCashWaterfallChart,
  CASH_UNCAPTURED_LABEL,
} from '@/modules/accounting/services/packs/pages/packPageCharts';
import { buildCashTable } from '@/modules/accounting/services/packs/pages/packStatementTables';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { cashCaption } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { demoSet, figures } from './fixtures/boardPackInputs';

const OPENING = 1_787_567.21;
const OPERATING = 345_678.12;
const INVESTING = -98_765.43;
const FINANCING = 12_345.67;
const CLOSING = 2_046_825.57;

const set: PackFigureSet = {
  ...demoSet,
  prior: figures({ cash: OPENING }),
  current: figures({
    cash: CLOSING,
    operatingCashFlow: OPERATING,
    investingCashFlow: INVESTING,
    financingCashFlow: FINANCING,
    capitalExpenditure: undefined,
  }),
};

describe('page 8 on cash figures that foot to the cent but not in floating point', () => {
  it('is fed figures that do foot, and whose float difference is not zero', () => {
    const cents = (n: number) => Math.round(n * 100);
    expect(cents(OPENING) + cents(OPERATING) + cents(INVESTING) + cents(FINANCING)).toBe(cents(CLOSING));
    // The trap: the same sum in doubles leaves dust.
    expect(CLOSING - OPENING - (OPERATING + INVESTING + FINANCING)).not.toBe(0);
  });

  it('draws a bridge of opening, three flows and closing, with no unexplained bar', () => {
    const bridge = buildCashWaterfallChart(set, PACK_SCALE);
    if (!bridge.drawn) throw new Error(`no bridge was drawn: ${bridge.why}`);
    expect(bridge.residual).toBe(0);
    const labels = bridge.chart.waterfallBars!.map((bar) => bar.label);
    expect(labels).toEqual(['Opening cash', 'Operating', 'Investing', 'Financing', 'Closing cash']);
    expect(labels).not.toContain(CASH_UNCAPTURED_LABEL);
  });

  it('draws investing at the net investing cash flow, signed as cash moved', () => {
    const bridge = buildCashWaterfallChart(set, PACK_SCALE);
    if (!bridge.drawn) throw new Error(`no bridge was drawn: ${bridge.why}`);
    const investing = bridge.chart.waterfallBars!.find((bar) => bar.label === 'Investing')!;
    expect(investing.end - investing.start).toBeCloseTo(INVESTING, 2);
  });

  it('captions the page without claiming any of the movement is unexplained', () => {
    const bridge = buildCashWaterfallChart(set, PACK_SCALE);
    if (!bridge.drawn) throw new Error(`no bridge was drawn: ${bridge.why}`);
    const caption = cashCaption(set, bridge.residual, PACK_SCALE);
    expect(caption).not.toMatch(/NOT explained|unexplained/i);
    expect(caption).toMatch(/^Operating activities generated/);
  });

  it('prints the investing row from the investing cash flow, not as an uncaptured figure', () => {
    const table = buildCashTable(set, new PackFigureProvenance());
    const row = table.rows.find((r) => r.label === 'Investing cash flow')!;
    expect(JSON.stringify(row)).not.toMatch(/no capital expenditure figure was captured/i);
    expect(JSON.stringify(row)).toContain(String(INVESTING));
  });

  /**
   * AND THE BAR IS STILL THERE WHEN THE FIGURES GENUINELY DO NOT FOOT. A
   * tolerance that swallowed a real gap would be the worse defect: the bridge
   * exists to say what the three flows leave unaccounted for.
   */
  it('still draws and captions a movement the three flows do not account for', () => {
    const short: PackFigureSet = { ...set, current: { ...set.current, cash: CLOSING + 5_000 } };
    const bridge = buildCashWaterfallChart(short, PACK_SCALE);
    if (!bridge.drawn) throw new Error(`no bridge was drawn: ${bridge.why}`);
    expect(bridge.residual).toBeCloseTo(5_000, 2);
    expect(bridge.chart.waterfallBars!.map((bar) => bar.label)).toContain(CASH_UNCAPTURED_LABEL);
    expect(cashCaption(short, bridge.residual, PACK_SCALE)).toMatch(/NOT explained/);
  });

  it('draws a one-cent gap too: a cent is money, not float dust', () => {
    const short: PackFigureSet = { ...set, current: { ...set.current, cash: CLOSING + 0.01 } };
    const bridge = buildCashWaterfallChart(short, PACK_SCALE);
    if (!bridge.drawn) throw new Error(`no bridge was drawn: ${bridge.why}`);
    expect(bridge.residual).not.toBe(0);
  });
});
