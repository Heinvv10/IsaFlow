/**
 * Two live recurring rows of one component that overlap in the period (W29 review #1901 round 4). The write guard
 * (payrollAssignmentWriteGuard) refuses an overlapping recurring row, so this is only reachable through legacy or
 * imported data; but where it exists both rows are read and both paid for the shared days (e.g. a successor starting ON a
 * leaver's end date pays the whole month plus its own share). The pro-rata guard flags it (edge 'overlap'), so approval
 * is refused naming the rows. Read-only; company-scoped; each pair once (the later-starting row is named).
 * It deliberately covers EVERY recurring row type, not only the earnings W29 apportions: two overlapping deductions,
 * hours, percent-of-RFI or defined-benefit rows are read and taken twice as well. Do not narrow it to apportionable
 * rows: it refuses more, never less.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

export interface OverlapRow { employeeId: string; employeeNumber: string; componentName: string; from: string; to: string | null; otherFrom: string }

export async function overlappingRecurringRows(
  companyId: string, employeeIds: string[], periodStart: string, last: string,
): Promise<OverlapRow[]> {
  if (employeeIds.length === 0) return [];
  const rows = (await sql`
    SELECT b.employee_id, e.employee_number, pc.name, b.effective_from, b.effective_to, a.effective_from AS other_from
      FROM payroll_employee_components a
      JOIN payroll_employee_components b ON b.employee_id = a.employee_id AND b.component_id = a.component_id AND b.id <> a.id
      JOIN payroll_employees e ON e.id = a.employee_id AND e.company_id = ${companyId}::uuid
      JOIN payroll_components pc ON pc.id = a.component_id AND pc.company_id = ${companyId}::uuid AND pc.is_active
     WHERE a.employee_id = ANY(${employeeIds}::uuid[])
       AND a.is_recurring AND b.is_recurring
       AND (a.effective_to IS NULL OR a.effective_to >= a.effective_from)
       AND (b.effective_to IS NULL OR b.effective_to >= b.effective_from)
       AND (a.effective_from, a.id) < (b.effective_from, b.id)
       AND b.effective_from <= COALESCE(a.effective_to, 'infinity'::date)
       AND b.effective_from <= ${last}::date
       AND COALESCE(b.effective_to, 'infinity'::date) >= ${periodStart}::date
       AND COALESCE(a.effective_to, 'infinity'::date) >= ${periodStart}::date
     ORDER BY e.employee_number, pc.name, b.effective_from
  `) as DbRow[];
  return rows.map((r) => ({
    employeeId: String(r.employee_id), employeeNumber: String(r.employee_number), componentName: String(r.name),
    from: fmtDate(r.effective_from), to: r.effective_to ? fmtDate(r.effective_to) : null, otherFrom: fmtDate(r.other_from),
  }));
}
