/**
 * Whether an employee already has a line on a FINAL pay run (wave 5 UXP): the profile's "Ready to pay" card says
 * "first pay run" only when this is false. Final is `isPayRunFinal` (the R-035 guard), never the status column.
 *
 * Cheaper than `listEmployeePayslips`: newest run first, and it stops at the first final one, so an employee who
 * has been paid costs one guard call; one with no final run has few runs to judge (capped at the history limit).
 * Company-scoped; an employee of another company is null (404 at the route).
 */
import { sql } from '@/lib/neon';
import { isPayRunFinal } from './payslipFinal';
import { PAYSLIP_HISTORY_LIMIT } from './payslipHistory';

export async function employeeHasFinalRun(companyId: string, employeeId: string): Promise<boolean | null> {
  const employee = await sql`
    SELECT 1 FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid`;
  if (employee.length === 0) return null;
  const runs = (await sql`
    SELECT prh.id::text AS run_id
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
     WHERE prh.company_id = ${companyId}::uuid
       AND prl.employee_id = ${employeeId}::uuid
       AND prh.status <> 'cancelled'
     ORDER BY prh.period_year DESC, prh.period_month DESC, prh.created_at DESC
     LIMIT ${PAYSLIP_HISTORY_LIMIT}
  `) as Array<{ run_id: string }>;
  for (const r of runs) {
    if (await isPayRunFinal(companyId, r.run_id)) return true;
  }
  return false;
}
