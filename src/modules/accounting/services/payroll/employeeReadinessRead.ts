/**
 * The three facts the profile's "Ready to pay" card needs, in ONE round trip (wave 6 UXR): are bank details on file,
 * which run month is next, and does the employee already have a line on a final run. The card used to make three
 * requests, each paying the full auth cost; the queries themselves are sub-millisecond.
 *
 * The bank fact is a boolean only (the masked view never needed the number). "Final" is the ONE predicate here (`employeeHasFinalRun` calls this), the rule of
 * `payslipFinal.isPayRunFinal` (approved or paid, with an approval time). The run list is cut to the latest worked-out run,
 * which is all `nextRunMonth` reads. Company-scoped; another company's employee is null (404 at the route).
 */
import { sql } from '@/lib/neon';
import { runOrderKeySql } from './payrollRunOrder';

export interface EmployeeReadinessRead {
  bank: 'on-file' | 'none';
  /** At most one run: the latest calculated / approved / paid one, shaped as the run list gives it. */
  runs: Array<{ periodYear: number; periodMonth: number; status: string }>;
  hasFinalRun: boolean;
}

interface Row { has_bank: boolean; has_final: boolean; latest: { periodYear: number; periodMonth: number; status: string } | null }

export async function readEmployeeReadiness(companyId: string, employeeId: string): Promise<EmployeeReadinessRead | null> {
  const rows = (await sql`
    SELECT
      EXISTS (SELECT 1 FROM payroll_bank_details
               WHERE company_id = ${companyId}::uuid AND employee_id = ${employeeId}::uuid AND is_active) AS has_bank,
      EXISTS (SELECT 1
                FROM payroll_run_lines prl
                JOIN payroll_run_headers prh ON prh.id = prl.run_id
               WHERE prh.company_id = ${companyId}::uuid
                 AND prl.employee_id = ${employeeId}::uuid
                 AND prh.status IN ('approved', 'paid')
                 AND COALESCE(prh.approved_at, prh.approval_grandfathered_at) IS NOT NULL) AS has_final,
      (SELECT json_build_object('periodYear', h.period_year, 'periodMonth', h.period_month, 'status', h.status)
         FROM payroll_run_headers h
        WHERE h.company_id = ${companyId}::uuid AND h.status IN ('calculated', 'approved', 'paid')
        ORDER BY ${runOrderKeySql('h')} DESC
        LIMIT 1) AS latest
     WHERE EXISTS (SELECT 1 FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid)
  `) as Row[];
  const row = rows[0];
  if (!row) return null;
  return { bank: row.has_bank ? 'on-file' : 'none', runs: row.latest ? [row.latest] : [], hasFinalRun: row.has_final };
}
