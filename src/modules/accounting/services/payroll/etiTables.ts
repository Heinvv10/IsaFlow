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
 * The April 2025 table is the law with no end date: the Rates and Monetary Amounts and Amendment of Revenue Laws Act
 * 3 of 2026, s7 (GG 54446, 1 April 2026), substituted ETI Act s7(2) and (3) with it, "deemed to have come into operation
 * on 1 April 2025" (s7(2) of that Act); s5 and s6 move the s4(1)(b) minimum to R2 500 and the s6(g) ceiling to R7 500
 * from the same date. SARS Guide to the Employment Tax Incentive, Issue 5 (27 July 2026), §5.1.2 p. 38 and fn 144.
 * The earlier "unconfirmed after 31 March 2026" warning and its policy switch are gone (ET, wave 5).
 */

/** Thrown for a pay period no ETI table covers. */
export class UnsupportedEtiPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEtiPeriodError';
  }
}

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
    throw new UnsupportedEtiPeriodError('No ETI table is loaded for pay periods before March 2022');
  }
  return idx < APRIL_2025 ? ETI_FROM_MARCH_2022 : ETI_FROM_APRIL_2025;
}

/** Which row of the table a remuneration falls in (each row's first-year formula is in the header). */
export type EtiBand = 'low' | 'flat' | 'taper' | 'nil';

/** The table row and its first-year amount, unrounded: what etiForRemuneration applies (exposed for the explanation). */
export function etiBandOf(remuneration: number, table: EtiTable): { band: EtiBand; yearOne: number } {
  if (remuneration >= table.wageCeiling) return { band: 'nil', yearOne: 0 };
  if (remuneration < table.lowBandCeiling) return { band: 'low', yearOne: table.lowBandRate * remuneration };
  if (remuneration < table.taperStart) return { band: 'flat', yearOne: table.maxMonthlyEti };
  return { band: 'taper', yearOne: table.maxMonthlyEti - table.taperRate * (remuneration - table.taperStart) };
}

/** Monthly incentive for an eligible employee; unrounded. */
export function etiForRemuneration(
  remuneration: number,
  employmentYear: 1 | 2,
  table: EtiTable,
): number {
  const { yearOne } = etiBandOf(remuneration, table);
  return Math.max(0, employmentYear === 1 ? yearOne : yearOne / 2);
}

/**
 * National minimum wage per ordinary hour, in cents, by pay period. ETI Act s4(1)(a): no ETI for a month whose wage is
 * less than the higher of a wage regulating measure and the amount in s4(1) of the National Minimum Wage Act 9 of 2018
 * (SARS Guide to the Employment Tax Incentive, Issue 5, 27 July 2026, §4.1 and §4.1.1, pp. 29-31).
 *  - from 1 March 2025: R28.79 (Minister of Employment and Labour, gov.za media statement 5 Feb 2025; GN R. 5830, GG 52053);
 *  - from 1 March 2026: R30.23 (NMW Act Schedule 1 item 1, substituted by GN R. 7083, GG 54075, 3 February 2026; the
 *    guide's Example 9 uses R30,23 for March 2026, p. 32).
 * NAMED LIMITS: no wage regulating measure (sectoral determination, bargaining council) is recorded, so the NMW is the
 * floor; an employer exempt under NMW Act s15 (ETI Act s4(1)(b): R2 500 a month, apportioned) and a learner on the
 * Schedule 2 allowance are not modelled. Before 1 March 2025 no rate is loaded: null, and the test is not run.
 */
const NATIONAL_MINIMUM_WAGE: readonly { from: number; centsPerHour: number }[] = [
  { from: 2026 * 12 + 2, centsPerHour: 3023 },
  { from: 2025 * 12 + 2, centsPerHour: 2879 },
];

export function nationalMinimumWageCents(periodDate: Date): number | null {
  const idx = monthIndex(periodDate);
  return NATIONAL_MINIMUM_WAGE.find((r) => idx >= r.from)?.centsPerHour ?? null;
}
