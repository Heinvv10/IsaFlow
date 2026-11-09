/**
 * Whether an employee already has a line on a FINAL pay run (wave 5 UXP): the profile's "Ready to pay" card says
 * "first pay run" only when this is false. Final is the one rule of `payslipFinal.isPayRunFinal`: the run is
 * `approved` or `paid` and carries an approval time (`COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL`).
 *
 * One EXISTS over every run, however many (no history cap: a cap would call an employee with many newer drafts
 * "first"). Company-scoped; an employee of another company is null (404 at the route).
 */
import { sql } from '@/lib/neon';

export async function employeeHasFinalRun(companyId: string, employeeId: string): Promise<boolean | null> {
  const employee = await sql`
    SELECT 1 FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid`;
  if (employee.length === 0) return null;
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
        FROM payroll_run_lines prl
        JOIN payroll_run_headers prh ON prh.id = prl.run_id
       WHERE prh.company_id = ${companyId}::uuid
         AND prl.employee_id = ${employeeId}::uuid
         AND prh.status IN ('approved', 'paid')
         AND COALESCE(prh.approved_at, prh.approval_grandfathered_at) IS NOT NULL
    ) AS has_final
  `) as Array<{ has_final: boolean }>;
  return rows[0]?.has_final === true;
}
