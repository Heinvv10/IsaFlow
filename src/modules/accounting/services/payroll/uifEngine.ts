import { getTaxYearConfig } from './taxTables';
import type { UifResult } from './payrollTypes';

export function calculateUIF(monthlySalary: number, taxYear: number): UifResult {
  const config = getTaxYearConfig(taxYear);
  const leviable = Math.min(monthlySalary, config.uifCeiling);
  const contribution = Math.round(leviable * 0.01 * 100) / 100;
  return {
    employeeContribution: contribution,
    employerContribution: contribution,
    isCapped: monthlySalary > config.uifCeiling,
  };
}
