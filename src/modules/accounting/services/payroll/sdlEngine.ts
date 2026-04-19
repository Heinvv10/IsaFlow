import { getTaxYearConfig } from './taxTables';

export function calculateSDL(
  monthlyLeviableAmount: number,
  estimatedAnnualPayroll: number,
  taxYear: number,
): number {
  const config = getTaxYearConfig(taxYear);
  if (estimatedAnnualPayroll <= config.sdlThresholdAnnual) return 0;
  return Math.round(monthlyLeviableAmount * 0.01 * 100) / 100;
}
