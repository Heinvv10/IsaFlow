/**
 * Read-only review: active employees flagged as medical-aid main members who
 * have no medical-aid deduction assigned.
 *
 * WHY. `medical_aid_main_member` buys the employee a monthly medical tax credit
 * in PAYE. Until D1 the flag defaulted to true on every create path, so an
 * employee captured without medical aid kept the credit and was under-deducted.
 * This lists the rows worth a human look; it changes nothing (no backfill, no
 * auto-fix: an employee may genuinely be a member paying through another route).
 *
 * The column's DEFAULT TRUE (migration 380) is left as it is here: migration 933
 * (D1b, its own PR, needs Hein's approval) changes it to FALSE. Until that is
 * deployed, an insert that leaves the column out still makes a main member, and
 * this report is how such a row is found.
 *
 * "Today" is the server's local calendar date (fmtDate uses local getters, and
 * the host runs on SAST), which is the date payroll cares about; callers can
 * pass `asAt` to pin it.
 *
 * "HAS A MEDICAL-AID DEDUCTION" means a payroll_employee_components assignment
 * in force on `asAt` whose component is an active deduction coded 4005 (the SARS
 * code the components page offers for medical aid). The schema has no medical
 * component type (component_type is only earning / deduction /
 * employer_contribution), so the SARS code is the one reliable marker; a name
 * match was dropped as free text. A medical component under another code shows
 * here and is dismissed by a human, which is the safe side for a review list.
 * Pay packages need no join of their own: applying one writes
 * payroll_employee_components rows (payPackageService).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export interface MedicalAidReviewEmployee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  medicalAidDependantsCount: number;
}

export async function listMainMembersWithoutMedicalDeduction(
  companyId: string,
  asAt: string = fmtDate(new Date()),
): Promise<MedicalAidReviewEmployee[]> {
  const rows = (await sql`
    SELECT e.id, e.employee_number, e.first_name, e.last_name, e.medical_aid_dependants_count
      FROM payroll_employees e
     WHERE e.company_id = ${companyId}::uuid
       AND e.status = 'active'
       AND e.medical_aid_main_member = true
       AND NOT EXISTS (
         SELECT 1
           FROM payroll_employee_components ec
           JOIN payroll_components c
             ON c.id = ec.component_id AND c.company_id = e.company_id
          WHERE ec.employee_id = e.id
            AND c.is_active = true
            AND c.component_type = 'deduction'
            AND c.sars_source_code = '4005'
            AND ec.effective_from <= ${asAt}::date
            AND (ec.effective_to IS NULL OR ec.effective_to >= ${asAt}::date)
       )
     ORDER BY e.last_name, e.first_name, e.employee_number
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id),
    employeeNumber: String(r.employee_number),
    firstName: String(r.first_name),
    lastName: String(r.last_name),
    medicalAidDependantsCount: Number(r.medical_aid_dependants_count) || 0,
  }));
}
