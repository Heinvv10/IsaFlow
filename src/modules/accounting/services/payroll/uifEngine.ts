import { getTaxYearConfig } from './taxTables';
import type { UifResult } from './payrollTypes';

/** UIF contribution rate, each of employee and employer (pinned by taxTableHash.test.ts). */
export const UIF_RATE = 0.01;

export function calculateUIF(monthlySalary: number, taxYear: number): UifResult {
  const config = getTaxYearConfig(taxYear);
  const leviable = Math.min(monthlySalary, config.uifCeiling);
  const contribution = Math.round(leviable * UIF_RATE * 100) / 100;
  return {
    employeeContribution: contribution,
    employerContribution: contribution,
    isCapped: monthlySalary > config.uifCeiling,
  };
}
