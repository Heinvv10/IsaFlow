/**
 * The annualisation factor F of the cumulative PAYE (payeCumulative.ts): AE = remuneration to date × F ÷ n, and the
 * tax after rebates on it is weighted n ÷ F. Statutory period ratios stay n ÷ 12 (coordinator ruling 2026-11-17): the
 * s11F cap to date (G21 p. 10) and the medical credits, a monthly amount. One source for every frequency (wave-6 AN).
 *
 * VENDOR PARITY, NOT A SARS RULE (wave-6 ruling 5, Hein 2026-11-15). No SARS guide prescribes days-based
 * annualisation: PAYE-GEN-01-G21 (2027) Rev 1 p. 8 (Fourth Schedule para 9(1)/(2)) gives AE = remuneration × periods
 * in the year ÷ periods worked, i.e. × 12 a month. Sage Payroll annualises a month by days, 365 ÷ 30.4166 (its
 * "View Tax Calculation" for R50 000 a month shows R600 001.37; tests/fixtures/payroll-oracle/sage-2027-03-phekis.json),
 * and AN follows Sage for monthly pay. 30.4166 is Sage's literal (365 ÷ 12 = 30.41666…, truncated), so F is
 * 12.0000263, not 12: the year's figures are a few cents from the statutory × 12 (oracle-an-diff.md).
 *
 * Weekly and fortnightly (wave-6 ruling 16, decided by O3's vendor probe, 2026-11-16): SimplePay documents
 * YTD × 52 ÷ periods worked, and no vendor showed 365 ÷ 7, so they are × 52 and × 26, as G21 p. 8 has them.
 * Only monthly is reachable until FQc costs weekly and fortnightly runs.
 */
import type { PayFrequency } from './payrollTypesRun';

/** Sage's days in a month (ruling 5). */
export const SAGE_DAYS_PER_MONTH = 30.4166;
export const DAYS_PER_YEAR = 365;

const FACTORS: Record<PayFrequency, number> = {
  monthly: DAYS_PER_YEAR / SAGE_DAYS_PER_MONTH,
  fortnightly: 26,
  weekly: 52,
};

/** F for a pay frequency: periods' worth of pay in a year. */
export function annualisationFactor(frequency: PayFrequency): number {
  return FACTORS[frequency];
}

/** How a factor reads in an explanation: "365 ÷ 30.4166" for the monthly one, else the number (26, 52). */
export function annualisationFactorWords(factor: number): string {
  return factor === FACTORS.monthly ? `${DAYS_PER_YEAR} ÷ ${SAGE_DAYS_PER_MONTH}` : String(factor);
}
