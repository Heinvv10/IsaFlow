/**
 * A rehired employee continues their ETI months (wave 5 ET review round 2, adv L5): "An eligible employer can only
 * claim the ETI for a maximum of 24 months per qualifying employee. The 24 months need not be consecutive" (SARS Guide
 * to the Employment Tax Incentive, Issue 5, §3.3 p. 28; §5.1 fn 142: "The 12 months need not be consecutive"). The months
 * an employee was employed by this employer before the current start date, on another employee record with the same
 * SA ID number, count towards the 12-month bands and the 24-month window (ETI Act s7(2), (3)).
 * Round 3 (adv3 L2): an earlier record matches by the same ID number OR the same employee number. A rehire on the SAME
 * record (start date moved forward) counts from the new start date only: the earlier months on that record are not
 * kept anywhere, so they are lost (named limit). NAMED LIMITS: employment by an associated person (s7(4)) is not
 * recorded; a permit holder is matched by employee number only (no permit number is stored); months in which the
 * employee did not qualify (e.g. under 18) are not told apart.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PayrollEmployee } from './payrollTypes';

const monthIndex = (d: Date): number => d.getFullYear() * 12 + d.getMonth();

/** The employees with `etiPriorMonths` set from the company's earlier records under the same ID number. */
export async function withEtiPriorMonths(companyId: string, employees: PayrollEmployee[]): Promise<PayrollEmployee[]> {
  const ids = [...new Set(employees.map((e) => e.idNumber?.replace(/\s+/g, '')).filter((n): n is string => !!n))];
  const numbers = [...new Set(employees.map((e) => e.employeeNumber).filter((n) => !!n))];
  if (ids.length === 0 && numbers.length === 0) return employees;
  const rows = (await sql`
    SELECT id, regexp_replace(id_number, '\\s+', '', 'g') AS id_number, employee_number, start_date, end_date
      FROM payroll_employees
     WHERE company_id = ${companyId}::uuid
       AND (regexp_replace(id_number, '\\s+', '', 'g') = ANY(${ids}::text[]) OR employee_number = ANY(${numbers}::text[]))
       AND end_date IS NOT NULL
  `) as DbRow[];
  return employees.map((e) => {
    const own = e.idNumber?.replace(/\s+/g, '');
    const prior = rows
      .filter((r) => String(r.id) !== e.id && new Date(String(r.end_date)) < e.startDate
        && ((own && String(r.id_number) === own) || String(r.employee_number) === e.employeeNumber))
      .reduce((t, r) => t + Math.max(0, monthIndex(new Date(String(r.end_date))) - monthIndex(new Date(String(r.start_date))) + 1), 0);
    return prior > 0 ? { ...e, etiPriorMonths: prior } : e;
  });
}
