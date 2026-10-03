/**
 * A REAL RATIO TOO SMALL FOR ITS PRECISION IS NOT THE NIL DASH.
 *
 * Velocity Fibre's production board pack printed its cash ratio as "–" on
 * page 9: cash of 277 over current liabilities of 80 584, in R'000 — 0.0034.
 * Page 12 defines the dash as "a figure measured and nil", so the pack told a
 * board the company holds no cash. The engine rounds every ratio to two
 * places before the pack sees it, 0.0034 arrived as exactly 0, and
 * `formatFigureText` prints an exact zero as the dash.
 *
 * Two halves, both held here: the read restores the measurement the engine
 * rounded away, and the formatter states a figure below its precision as a
 * bound — `<0.01×` — the way `formatMoney` already states an amount below its
 * scale as `<1`.
 */
import { describe, expect, it } from 'vitest';
import { formatDays, formatPctLevel, formatRatio, formatTimes } from '@/lib/format/money';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildScorecardGroups, packFiguresToFinancialData } from '@/modules/accounting/services/packs/pages/packScorecard';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { demoSet } from './fixtures/boardPackInputs';

describe('a figure below the precision it is printed at', () => {
  it('is a bound for a ratio, in the bracket where it is negative', () => {
    expect(formatRatio(0.0034)).toBe('<0.01');
    expect(formatRatio(-0.0034)).toBe('(<0.01)');
    expect(formatTimes(0.0034)).toBe('<0.01×');
    expect(formatTimes(-0.0034)).toBe('(<0.01)×');
  });

  it('is a bound for a day count and a percentage level', () => {
    expect(formatDays(0.3)).toBe('<1 day');
    expect(formatDays(-0.3)).toBe('(<1 day)');
    expect(formatPctLevel(0.04)).toBe('<0.1%');
    expect(formatPctLevel(-0.04)).toBe('(<0.1%)');
  });

  it('leaves a measured zero and a figure that reaches its precision alone', () => {
    // The pair the bound must not swallow: a true zero is still the zero the
    // formatter has always printed, and 0.01 is a figure, not a bound.
    expect(formatRatio(0)).toBe('0.00');
    expect(formatRatio(0.01)).toBe('0.01');
    expect(formatRatio(0.006)).toBe('0.01');
    expect(formatDays(0)).toBe('0 days');
    expect(formatDays(2.6)).toBe('3 days');
    expect(formatPctLevel(0)).toBe('0.0%');
    expect(formatPctLevel(0.06)).toBe('0.1%');
  });
});

/** Velocity Fibre's balance sheet at 2 October 2026, as page 7 printed it. */
const velocityShaped: PackFigureSet = {
  ...demoSet,
  current: {
    ...demoSet.current,
    cash: 277_097,
    currentAssets: 31_838_412,
    currentLiabilities: 80_584_330,
  },
};

const rowOf = (set: PackFigureSet, metric: string) => buildScorecardGroups(set, new PackFigureProvenance())
  .flatMap((g) => g.rows).find((r) => r.metric === metric)!;

describe('page 9\'s cash ratio on Velocity Fibre\'s figures', () => {
  it('arrives from the engine rounded to nothing — the path this guards', () => {
    expect(calculateExtendedRatios(packFiguresToFinancialData(velocityShaped.current)).cashRatio).toBe(0);
  });

  it('is the measured quotient, printed as a bound and not as nil', () => {
    const cash = rowOf(velocityShaped, 'Cash ratio');
    expect(cash.actual.value).toBeCloseTo(277_097 / 80_584_330, 10);
    expect(formatFigureText(cash.actual, PACK_SCALE)).toBe('<0.01×');
  });

  it('keeps the engine\'s figure wherever the engine stated one', () => {
    // 0.40, not 0.395... — the restoration is for the rounding-to-zero path
    // alone, so the scorecard still agrees with Financial Analysis elsewhere.
    const current = rowOf(velocityShaped, 'Current ratio');
    expect(current.actual.value).toBe(0.4);
  });
});

describe('every ratio page 9 states takes the same path', () => {
  // Each figure is chosen so the engine's two-place rounding gives exactly 0
  // while the measured quotient is not nil.
  const tiny: Array<[string, Partial<PackFigureSet['current']>, string]> = [
    ['Current ratio', { currentAssets: 300, currentLiabilities: 80_584_330 }, '<0.01×'],
    ['Debt-to-equity', { totalLiabilities: 2_000, totalEquity: 9_000_000 }, '<0.01×'],
    ['Interest cover', { operatingProfit: 10, interestExpense: 48_000 }, '<0.01×'],
    ['Debtor days', { accountsReceivable: 1, revenue: 100_000_000 }, '<1 day'],
    ['Creditor days', { accountsPayable: 1, costOfSales: 100_000_000 }, '<1 day'],
  ];
  it('restores debtor days annualised, as the engine annualises them', () => {
    // 1 000 owed on 100 000 000 of revenue: 0.00365 days. The engine's
    // two-place figure is 0; the restored one is the same quotient times 365.
    const set: PackFigureSet = { ...demoSet, current: { ...demoSet.current, accountsReceivable: 1_000, revenue: 100_000_000 } };
    expect(rowOf(set, 'Debtor days').actual.value).toBeCloseTo((1_000 / 100_000_000) * 365, 10);
  });

  for (const [metric, override, expected] of tiny) {
    it(`${metric} prints ${expected}, not the nil dash`, () => {
      const set: PackFigureSet = { ...demoSet, current: { ...demoSet.current, ...override } };
      const row = rowOf(set, metric);
      expect(row.actual.value).not.toBe(0);
      expect(formatFigureText(row.actual, PACK_SCALE)).toBe(expected);
    });
  }
});
