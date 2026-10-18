/**
 * Employment Tax Incentive (ETI) formula, effective by pay period.
 *
 * Source: https://www.sars.gov.za (ETI, "How much is the incentive", verified
 * 2026-10-18). Monthly remuneration R, first 12 months of employment (the
 * second 12 months pay exactly half of every amount):
 *
 *   from 1 April 2025   R < 2 500          60% x R
 *                       2 500 <= R < 5 500 R1 500
 *                       5 500 <= R < 7 500 R1 500 - 75% x (R - 5 500)
 *                       R >= 7 500         nil
 *   1 Mar 2022 - 31 Mar 2025
 *                       R < 2 000          75% x R
 *                       2 000 <= R < 4 500 R1 500
 *                       4 500 <= R < 6 500 R1 500 - 75% x (R - 4 500)
 *                       R >= 6 500         nil
 *
 * ASSUMPTION, UNCONFIRMED: the April 2025 table is applied to every period
 * after 31 March 2026 as well. The Employment Tax Incentive Amendment Act
 * (Act 3 of 2026, 1 April 2026) may have changed it and its text was not
 * available; confirm before relying on ETI for periods from April 2026.
 */

export interface EtiTable {
  /** Below this remuneration the incentive is `lowBandRate` x remuneration. */
  lowBandCeiling: number;
  /** First-year rate inside the low band. */
  lowBandRate: number;
  /** First-year flat amount between the low band and `taperStart`. */
  maxMonthlyEti: number;
  /** Remuneration at which the incentive starts to taper. */
  taperStart: number;
  /** Fraction of the excess over `taperStart` deducted from `maxMonthlyEti`. */
  taperRate: number;
  /** At or above this remuneration the incentive is nil. */
  wageCeiling: number;
}

const ETI_FROM_MARCH_2022: EtiTable = {
  lowBandCeiling: 2_000,
  lowBandRate: 0.75,
  maxMonthlyEti: 1_500,
  taperStart: 4_500,
  taperRate: 0.75,
  wageCeiling: 6_500,
};

const ETI_FROM_APRIL_2025: EtiTable = {
  lowBandCeiling: 2_500,
  lowBandRate: 0.6,
  maxMonthlyEti: 1_500,
  taperStart: 5_500,
  taperRate: 0.75,
  wageCeiling: 7_500,
};

/** Months since year 0 of a pay period: January 2025 is 2025 x 12 + 0. */
function monthIndex(periodDate: Date): number {
  return periodDate.getFullYear() * 12 + periodDate.getMonth();
}

const MARCH_2022 = 2022 * 12 + 2;
const APRIL_2025 = 2025 * 12 + 3;

export function selectEtiTable(periodDate: Date): EtiTable {
  const idx = monthIndex(periodDate);
  if (idx < MARCH_2022) {
    throw new Error('No ETI table is loaded for pay periods before March 2022');
  }
  return idx < APRIL_2025 ? ETI_FROM_MARCH_2022 : ETI_FROM_APRIL_2025;
}

/** Monthly incentive for an eligible employee; unrounded. */
export function etiForRemuneration(
  remuneration: number,
  employmentYear: 1 | 2,
  table: EtiTable,
): number {
  let yearOne: number;
  if (remuneration >= table.wageCeiling) {
    yearOne = 0;
  } else if (remuneration < table.lowBandCeiling) {
    yearOne = table.lowBandRate * remuneration;
  } else if (remuneration < table.taperStart) {
    yearOne = table.maxMonthlyEti;
  } else {
    yearOne = table.maxMonthlyEti - table.taperRate * (remuneration - table.taperStart);
  }
  return Math.max(0, employmentYear === 1 ? yearOne : yearOne / 2);
}
