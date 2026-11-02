/**
 * The pro-rata guard (Hein, 2026-11-02). A run reads components on its period's last day (payrollRunReadDate) and
 * does not apportion. So a RECURRING row that starts after the 27th of the run month is paid in full, and one that
 * ends from the 27th to the day before the last day is not paid at all. Neither may pass silently:
 *   - calculatePayrollRun puts RECURRING_NEEDS_PRO_RATA on the employee's line (proRataValidation);
 *   - the approval gate refuses the run (`recurring_needs_pro_rata`, runProRataBlocker) while any of the run's
 *     employees has such a row now, or the run still carries the flag from its calculation (a row changed since,
 *     not yet recalculated: the run's figures are still the old ones).
 * IsaFlow has no per-employee hold, so the refusal is for the whole run, naming each employee.
 * Rows that start or end on other days keep the behaviour they always had (paid in full / not paid) and are not
 * flagged. Once-offs are not flagged: each is paid once in its own month. A voided row (ends before it starts) is
 * never paid and is ignored.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { payrollRunReadDate } from './payrollRunReadDate';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { PayrollPeriod, ValidationResult } from './payrollTypes';

export const PRO_RATA_CODE = 'RECURRING_NEEDS_PRO_RATA';

export interface ProRataRow {
  employeeId: string;
  employeeNumber: string;
  componentName: string;
  edge: 'starts' | 'ends';
  date: string;
}

/** The recurring rows of these employees (in this company) that start or end inside the period's pro-rata band. */
export async function recurringRowsNeedingProRata(
  companyId: string,
  period: PayrollPeriod,
  employeeIds: string[],
): Promise<ProRataRow[]> {
  if (employeeIds.length === 0) return [];
  const last = payrollRunReadDate(period);
  const day27 = `${last.slice(0, 8)}27`;
  const rows = (await sql`
    SELECT pec.employee_id, e.employee_number, pc.name, pec.effective_from, pec.effective_to,
           pec.effective_from > ${day27}::date AS starts
    FROM payroll_employee_components pec
    JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
    JOIN payroll_components pc ON pc.id = pec.component_id AND pc.company_id = ${companyId}::uuid
    WHERE pec.employee_id = ANY(${employeeIds}::uuid[])
      AND pec.is_recurring = TRUE
      AND pc.is_active = TRUE
      AND (pec.effective_to IS NULL OR pec.effective_to >= pec.effective_from)
      AND (
        (pec.effective_from > ${day27}::date AND pec.effective_from <= ${last}::date)
        OR (pec.effective_to >= ${day27}::date AND pec.effective_to < ${last}::date)
      )
    ORDER BY e.employee_number, pc.name, pec.effective_from
  `) as DbRow[];
  return rows.map((r) => ({
    employeeId: String(r.employee_id),
    employeeNumber: String(r.employee_number),
    componentName: String(r.name),
    edge: r.starts ? 'starts' : 'ends',
    date: fmtDate(r.starts ? r.effective_from : r.effective_to),
  }));
}

/** The line's flag for one such row. */
export function proRataValidation(row: ProRataRow): ValidationResult {
  const effect = row.edge === 'starts' ? 'is paid in full' : 'is not paid';
  return {
    code: PRO_RATA_CODE,
    severity: 'error',
    field: 'components',
    message: `${row.componentName} ${row.edge} on ${row.date}: this recurring component ${effect} in this run and needs a manual `
      + 'pro-rata. Change its dates (for example, start it on the 1st of next month and capture the part month as a '
      + 'once-off), then recalculate. Approval is refused until then.',
  };
}

/** The approval refusal for the run, or null. Read-only. */
export async function runProRataBlocker(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const lines = (await sql`
    SELECT l.employee_id, e.employee_number, h.period_year, h.period_month,
           jsonb_path_exists(l.validation_results, ${`$[*] ? (@.code == "${PRO_RATA_CODE}")`}::jsonpath) AS flagged
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid
    ORDER BY e.employee_number
  `) as DbRow[];
  const head = lines[0];
  if (!head) return null;
  const period = { year: Number(head.period_year), month: Number(head.period_month) };
  const live = await recurringRowsNeedingProRata(companyId, period, lines.map((l) => String(l.employee_id)));
  const liveIds = new Set(live.map((r) => r.employeeId));
  const stale = lines.filter((l) => l.flagged && !liveIds.has(String(l.employee_id))).map((l) => String(l.employee_number));
  if (live.length === 0 && stale.length === 0) return null;
  const parts: string[] = [];
  if (live.length > 0) {
    parts.push('Recurring components start after the 27th or end between the 27th and the last day of the month, so this '
      + 'run pays them in full or not at all; each needs a manual pro-rata: '
      + live.map((r) => `${r.employeeNumber} ${r.componentName} ${r.edge} on ${r.date}`).join('; ')
      + '. Change those rows\' dates, then recalculate.');
  }
  if (stale.length > 0) {
    parts.push(`The run was calculated before the pro-rata was resolved for ${stale.join(', ')}: recalculate it.`);
  }
  return { code: 'recurring_needs_pro_rata', detail: parts.join(' ') };
}
