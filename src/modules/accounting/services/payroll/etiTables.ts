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
 * after 31 March 2026 as well, although SARS describes it as running for 12
 * months. The Employment Tax Incentive Amendment Act (Act 3 of 2026,
 * 1 April 2026) may have changed it and its text was not available. Until that
 * is decided, `ETI_AFTER_MARCH_2026_POLICY` governs those periods.
 */

/** Thrown for a pay period no ETI table covers. */
export class UnsupportedEtiPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEtiPeriodError';
  }
}

/**
 * What to do with pay periods from 1 April 2026, whose ETI table is unconfirmed:
 *  - 'warn'        keep claiming on the April 2025 table; every line with ETI > 0
 *                  carries a non-blocking ETI_TABLE_UNCONFIRMED warning.
 *  - 'fail_closed' claim nothing for those periods (monthlyEti 0, reported ineligible).
 * Flip this one constant once Hein decides.
 */
export type EtiUnconfirmedPolicy = 'warn' | 'fail_closed';
export const ETI_AFTER_MARCH_2026_POLICY: EtiUnconfirmedPolicy = 'warn';

export const ETI_TABLE_UNCONFIRMED_MESSAGE =
  'The ETI table for pay periods after 31 March 2026 is unconfirmed: the April 2025 table has been '
  + 'applied, but SARS describes it as running for 12 months and the 1 April 2026 amendment has not '
  + 'been checked. Verify the ETI claimed before submitting the EMP201.';

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
const APRIL_2026 = 2026 * 12 + 3;

/** True for a pay period from 1 April 2026, whose ETI table is unconfirmed. */
export function isEtiTableUnconfirmed(periodDate: Date): boolean {
  return monthIndex(periodDate) >= APRIL_2026;
}

export function selectEtiTable(periodDate: Date): EtiTable {
  const idx = monthIndex(periodDate);
  if (idx < MARCH_2022) {
    throw new UnsupportedEtiPeriodError('No ETI table is loaded for pay periods before March 2022');
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
