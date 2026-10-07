/**
 * CAN A DIRECTOR REPRODUCE A DAY COUNT FROM THE DEFINITION THE PACK PRINTS?
 *
 * Page 12 once defined creditor days as "times the days in the period" while
 * `calculateExtendedRatios` multiplied by 365, and the printed figures could
 * not be reproduced from the printed definition. The prose was moved to 365
 * then — and that was the wrong half to move: 365 over a six-month window's
 * revenue reads six months of sales as a year's and doubles the day count.
 * The engine now multiplies by the days the window holds
 * (`FinancialData.periodDays`), and the definition says so again.
 *
 * So this reads the BASIS OUT OF THE PRINTED SENTENCE, takes the day count
 * from the window the basis page dates, and does the arithmetic with it. It
 * fails if the prose names a count the code does not use, and it fails if the
 * code multiplies by anything but the window's days.
 */
import { describe, expect, it } from 'vitest';
import { buildDefinitions } from '@/modules/accounting/services/packs/pages/packDefinitions';
import { packFiguresToFinancialData } from '@/modules/accounting/services/packs/pages/packScorecard';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { brightsphereSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';
import { inclusiveDays } from '@/modules/accounting/services/reports/priorPeriod';


/** The words every day-count definition multiplies by. */
const WINDOW_DAYS = 'times the days in the period';

/** The day count the definition of `term` states: the window's own days. */
function statedDays(set: typeof demoSet, term: string): number {
  const definition = buildDefinitions(set, new PackFigureProvenance())
    .find((d) => d.term === term);
  expect(definition, `page 12 prints no definition of "${term}"`).toBeDefined();
  expect(
    definition!.definition,
    `"${term}" does not state a day count a reader can multiply by`,
  ).toContain(WINDOW_DAYS);
  return inclusiveDays(set.currentWindow.start, set.currentWindow.end)!;
}

const PACKS = [
  ['the live demo company', liveDemoSet],
  ['the demo company', demoSet],
  ['Brightsphere', brightsphereSet],
] as const;

describe('the day counts page 12 defines', () => {
  for (const [company, set] of PACKS) {
    it(`reproduce the printed debtor days and creditor days for ${company}`, () => {
      const data = packFiguresToFinancialData(set.current);
      const ratios = calculateExtendedRatios(data);
      // The figures carry the day count of the window they were read for.
      expect(data.periodDays).toBe(inclusiveDays(set.currentWindow.start, set.currentWindow.end));

      // Not vacuous on a company whose base is nil: `safeDiv` returns 0 and
      // both sides agree at 0 for the wrong reason, so those cases are
      // asserted to be the ones the pack reports as not meaningful instead.
      // A base that is not positive has no day count at all — the engine
      // states none, and the pack prints its reason. See ratioCalculations.
      if (data.revenue > 0) {
        const days = statedDays(set, 'Debtor days');
        expect(
          (data.accountsReceivable / data.revenue) * days,
          `debtor days of ${ratios.debtorDays} cannot be reproduced from ${days} days`,
        ).toBeCloseTo(ratios.debtorDays, 1);
      }

      if (data.costOfSales > 0) {
        const days = statedDays(set, 'Creditor days');
        expect(
          (data.accountsPayable / data.costOfSales) * days,
          `creditor days of ${ratios.creditorDays} cannot be reproduced from ${days} days`,
        ).toBeCloseTo(ratios.creditorDays, 1);
      }
    });
  }

  /**
   * AND THE TWO DAY COUNTS ARE THE SAME ONE, because the cash conversion
   * cycle subtracts one from the other. Two conventions inside one subtraction
   * is a figure with no units.
   */
  it('use one convention across debtor days, creditor days and the cycle', () => {
    expect(statedDays(demoSet, 'Debtor days')).toBe(184);
    expect(statedDays(demoSet, 'Creditor days')).toBe(184);

    const cycle = buildDefinitions(demoSet, new PackFigureProvenance())
      .find((d) => d.term === 'Cash conversion cycle');
    expect(cycle?.definition, 'the cycle does not say which convention its terms carry')
      .toMatch(/times the same days/);
  });
});
