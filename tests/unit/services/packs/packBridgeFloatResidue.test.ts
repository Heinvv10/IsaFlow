/**
 * FLOAT RESIDUE IS NOT AN UNEXPLAINED MOVEMENT.
 *
 * Both bridges close their own gap with a named plug bar — "Unexplained
 * movement" on cash, "Other, not separately captured" on profit — and both
 * decided whether there WAS a gap with `!== 0` on a difference of floats.
 * 100 000.30 − 100 000.10 − 0.20 is not zero in binary; it is a few
 * hundred-billionths of a rand, and that drew a zero-height bar with a label
 * telling the board part of the movement in cash is not explained.
 *
 * The figures below foot exactly in decimal. The first test proves they do
 * NOT foot in floating point, so the cases cannot go vacuous.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCashWaterfallChart,
  buildProfitWaterfallChart,
  CASH_UNCAPTURED_LABEL,
  PROFIT_UNCAPTURED_LABEL,
} from '@/modules/accounting/services/packs/pages/packPageCharts';
import { cashCaption } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { demoSet, figures } from './fixtures/boardPackInputs';

const CASH = { opening: 100_000.1, operating: 0.2, closing: 100_000.3 };
const PROFIT = { revenue: 1_000.3, costOfSales: 500.1, operatingExpenses: 400.1, netProfit: 100.1 };

const cashSet: PackFigureSet = {
  ...demoSet,
  current: figures({ cash: CASH.closing, operatingCashFlow: CASH.operating, capitalExpenditure: 0, financingCashFlow: 0 }),
  prior: figures({ cash: CASH.opening }),
};

const profitSet: PackFigureSet = {
  ...demoSet,
  current: figures({
    ...PROFIT, otherIncome: 0, otherExpenses: 0, operatingProfit: PROFIT.netProfit,
  }),
};

const labels = (chart: { waterfallBars?: Array<{ label: string }> }): string[] =>
  (chart.waterfallBars ?? []).map((bar) => bar.label);

describe('a bridge that foots to the cent draws no plug bar', () => {
  it('is the case under test — these figures foot in decimal and not in binary', () => {
    expect(CASH.closing - CASH.opening - CASH.operating).not.toBe(0);
    expect(Math.abs(CASH.closing - CASH.opening - CASH.operating)).toBeLessThan(1e-6);
    const walked = PROFIT.revenue - PROFIT.costOfSales - PROFIT.operatingExpenses;
    expect(PROFIT.netProfit - walked).not.toBe(0);
    expect(Math.abs(PROFIT.netProfit - walked)).toBeLessThan(1e-6);
  });

  it('cash: no "Unexplained movement" bar, and no residual to caption', () => {
    const bridge = buildCashWaterfallChart(cashSet, PACK_SCALE);
    if (!bridge.drawn) throw new Error('the cash bridge was not drawn');
    expect(labels(bridge.chart)).not.toContain(CASH_UNCAPTURED_LABEL);
    expect(bridge.residual).toBe(0);
  });

  it('cash: still draws the bar for a real cent of difference', () => {
    const short: PackFigureSet = { ...cashSet, current: { ...cashSet.current, cash: CASH.closing + 0.02 } };
    const bridge = buildCashWaterfallChart(short, PACK_SCALE);
    if (!bridge.drawn) throw new Error('the cash bridge was not drawn');
    expect(labels(bridge.chart)).toContain(CASH_UNCAPTURED_LABEL);
    expect(bridge.residual).toBeCloseTo(0.02, 6);
  });

  it('profit: no "Other, not separately captured" bar', () => {
    expect(labels(buildProfitWaterfallChart(profitSet, PACK_SCALE))).not.toContain(PROFIT_UNCAPTURED_LABEL);
  });

  it('profit: still draws the bar for a real cent of difference', () => {
    const short: PackFigureSet = { ...profitSet, current: { ...profitSet.current, netProfit: PROFIT.netProfit + 0.02 } };
    expect(labels(buildProfitWaterfallChart(short, PACK_SCALE))).toContain(PROFIT_UNCAPTURED_LABEL);
  });

  it('the cash caption does not explain a residual that is residue', () => {
    const lead = cashCaption(cashSet, 0, PACK_SCALE);
    expect(cashCaption(cashSet, 2.9e-11, PACK_SCALE)).toBe(lead);
    expect(cashCaption(cashSet, -2.9e-11, PACK_SCALE)).toBe(lead);
    expect(cashCaption(cashSet, 0.02, PACK_SCALE)).toMatch(/NOT explained/);
  });
});
