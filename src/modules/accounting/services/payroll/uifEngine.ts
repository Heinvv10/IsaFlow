import { getTaxYearConfig } from './taxTables';
import type { UifResult } from './payrollTypes';

/** UIF contribution rate, each of employee and employer (pinned by taxTableHash.test.ts). */
export const UIF_RATE = 0.01;

/**
 * A line's UIF, and the pay its contributions are on (the lesser of the pay and the ceiling, never below nil), for the
 * explanation. UIC Act 4 of 2002 s5(1) with s6(1)(a)/(b): a monthly contribution of 1% each of the remuneration paid or
 * payable during the month; s6(2): not on remuneration above the Minister's ceiling. Nothing carries a negative month
 * forward, so a clawback larger than the month's pay gives nil, never a negative contribution (UF, wave 6). An earlier
 * month over-declared is corrected through that month (refunds: s8(3), s7(5)); the line warns (uifClawbackWarning).
 *
 * `monthToDate` (wave 6 FQc): the UIF remuneration the employee's earlier runs paid in the same month (a weekly or
 * fortnightly employee's). The ceiling is on remuneration "paid or payable ... during any month" (s6(1)(a)(i)), and
 * the Minister's notice limits it to "so much of the remuneration paid or payable by an employer to an employee
 * during any month, as exceeds R17 712" (National Treasury Notice 475, GG 44641, 28 May 2021, p. 3; coordinator
 * ruling 2026-11-16: no derived weekly ceiling). So the line levies only the room left under the month's ceiling.
 */
export function uifWithLeviable(monthlySalary: number, taxYear: number, monthToDate = 0): { uif: UifResult; leviable: number } {
  const config = getTaxYearConfig(taxYear);
  const room = Math.max(0, config.uifCeiling - Math.max(0, monthToDate));
  const leviable = Math.max(0, Math.min(monthlySalary, room));
  const contribution = Math.round(leviable * UIF_RATE * 100) / 100;
  return {
    uif: { employeeContribution: contribution, employerContribution: contribution, isCapped: monthlySalary > room },
    leviable,
  };
}
