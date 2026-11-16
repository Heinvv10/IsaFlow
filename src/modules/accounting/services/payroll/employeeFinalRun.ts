/**
 * Whether an employee already has a line on a FINAL pay run (wave 5 UXP): the profile's "Ready to pay" card says
 * "first pay run" only when this is false. Final is the one rule of `payslipFinal.isPayRunFinal`: the run is
 * `approved` or `paid` and carries an approval time (`COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL`).
 *
 * One EXISTS over every run, however many (no history cap: a cap would call an employee with many newer drafts
 * "first"). Company-scoped; an employee of another company is null (404 at the route).
 */
import { readEmployeeReadiness } from './employeeReadinessRead';

/** The one final-run predicate lives in `readEmployeeReadiness` (wave 6 UXR); this is its single-fact view. */
export async function employeeHasFinalRun(companyId: string, employeeId: string): Promise<boolean | null> {
  const read = await readEmployeeReadiness(companyId, employeeId);
  return read ? read.hasFinalRun : null;
}
