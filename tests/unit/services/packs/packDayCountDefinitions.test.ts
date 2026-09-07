/**
 * CAN A DIRECTOR REPRODUCE A DAY COUNT FROM THE DEFINITION THE PACK PRINTS?
 *
 * Page 12 defined creditor days as "trade payables over cost of sales, times
 * the days in the period". `calculateExtendedRatios` multiplies by 365, and
 * always has. Applying the printed definition to the printed figures made the
 * measure impossible: 1 035 days × cost of sales of 805 ÷ 245 days implies
 * trade payables of 3 401 against total liabilities of 2 281. Substituting
 * 365 resolves it to 2 283, which ties to 2 281 within the rounding the page
 * declares. The figures were right and the definition was wrong — a
 * disclosure failure, and the kind a CFO is asked about in the meeting and
 * cannot answer from the pack.
 *
 * So this reads the DAY COUNT OUT OF THE PRINTED SENTENCE and does the
 * arithmetic with it. It fails if the prose changes to a count the code does
 * not use, and it fails if the code changes to a count the prose does not
 * state. A string match against "365" would only ever have caught the first.
 */
import { describe, expect, it } from 'vitest';
import { buildDefinitions } from '@/modules/accounting/services/packs/pages/packDefinitions';
import { toFinancialData } from '@/modules/accounting/services/packs/pages/packScorecard';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { brightsphereSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';


/** The day count the definition of `term` states, as a number. */
function statedDays(set: typeof demoSet, term: string): number {
  const definition = buildDefinitions(set, new PackFigureProvenance())
    .find((d) => d.term === term);
  expect(definition, `page 12 prints no definition of "${term}"`).toBeDefined();

  const match = /times (\d[\d\s\u00a0]*)/.exec(definition!.definition);
  expect(
    match,
    `"${term}" does not state a day count a reader can multiply by: ${definition!.definition}`,
  ).not.toBeNull();
  return Number((match![1] ?? '').replace(/\s/g, ''));
}

const PACKS = [
  ['the live demo company', liveDemoSet],
  ['the demo company', demoSet],
  ['Brightsphere', brightsphereSet],
] as const;

describe('the day counts page 12 defines', () => {
  for (const [company, set] of PACKS) {
    it(`reproduce the printed debtor days and creditor days for ${company}`, () => {
      const data = toFinancialData(set.current);
      const ratios = calculateExtendedRatios(data);

      // Not vacuous on a company whose base is nil: `safeDiv` returns 0 and
      // both sides agree at 0 for the wrong reason, so those cases are
      // asserted to be the ones the pack reports as not meaningful instead.
      if (data.revenue !== 0) {
        const days = statedDays(set, 'Debtor days');
        expect(
          (data.accountsReceivable / data.revenue) * days,
          `debtor days of ${ratios.debtorDays} cannot be reproduced from "times ${days}"`,
        ).toBeCloseTo(ratios.debtorDays, 1);
      }

      if (data.costOfSales !== 0) {
        const days = statedDays(set, 'Creditor days');
        expect(
          (data.accountsPayable / data.costOfSales) * days,
          `creditor days of ${ratios.creditorDays} cannot be reproduced from "times ${days}"`,
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
    expect(statedDays(demoSet, 'Debtor days')).toBe(365);
    expect(statedDays(demoSet, 'Creditor days')).toBe(365);

    const cycle = buildDefinitions(demoSet, new PackFigureProvenance())
      .find((d) => d.term === 'Cash conversion cycle');
    expect(cycle?.definition, 'the cycle does not say which convention its terms carry')
      .toMatch(/annualised on 365 days/);
  });
});
