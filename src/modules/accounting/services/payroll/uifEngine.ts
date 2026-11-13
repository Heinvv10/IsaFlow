import { getTaxYearConfig } from './taxTables';
import type { UifResult } from './payrollTypes';

/** UIF contribution rate, each of employee and employer (pinned by taxTableHash.test.ts). */
export const UIF_RATE = 0.01;

/** A line's UIF, and the pay its contributions are on (the lesser of the pay and the ceiling), for the explanation. */
export function uifWithLeviable(monthlySalary: number, taxYear: number): { uif: UifResult; leviable: number } {
  const config = getTaxYearConfig(taxYear);
  const leviable = Math.min(monthlySalary, config.uifCeiling);
  const contribution = Math.round(leviable * UIF_RATE * 100) / 100;
  return {
    uif: { employeeContribution: contribution, employerContribution: contribution, isCapped: monthlySalary > config.uifCeiling },
    leviable,
  };
}
