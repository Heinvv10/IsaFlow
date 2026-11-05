import { getTaxYearConfig } from './taxTables';

/** Section 4(b): an employer whose twelve-month remuneration is at or under the threshold levies nothing. */
export function isSdlExempt(estimatedAnnualPayroll: number, taxYear: number): boolean {
  return estimatedAnnualPayroll <= getTaxYearConfig(taxYear).sdlThresholdAnnual;
}

export function calculateSDL(
  monthlyLeviableAmount: number,
  estimatedAnnualPayroll: number,
  taxYear: number,
): number {
  if (isSdlExempt(estimatedAnnualPayroll, taxYear)) return 0;
  return Math.round(monthlyLeviableAmount * 0.01 * 100) / 100;
}
