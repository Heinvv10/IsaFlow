import { getTaxYearConfig } from './taxTables';
import type { UifResult } from './payrollTypes';

/** UIF contribution rate, each of employee and employer (pinned by taxTableHash.test.ts). */
export const UIF_RATE = 0.01;

/**
 * A line's UIF, and the pay its contributions are on (the lesser of the pay and the ceiling, never below nil), for the
 * explanation. UIC Act 4 of 2002 s6(1)(a)/(b): 1% each of the remuneration paid or payable in the month; s6(2): not on
 * remuneration above the Minister's ceiling. A clawback larger than the month's pay leaves nothing paid to levy, so the
 * contribution is nil, never negative (UF, wave 6).
 */
export function uifWithLeviable(monthlySalary: number, taxYear: number): { uif: UifResult; leviable: number } {
  const config = getTaxYearConfig(taxYear);
  const leviable = Math.max(0, Math.min(monthlySalary, config.uifCeiling));
  const contribution = Math.round(leviable * UIF_RATE * 100) / 100;
  return {
    uif: { employeeContribution: contribution, employerContribution: contribution, isCapped: monthlySalary > config.uifCeiling },
    leviable,
  };
}
