/**
 * The pro-rata guard (Hein, 2026-11-02). A run reads components on its period's last day (payrollRunReadDate) and
 * does not apportion. So a RECURRING row that starts after the 27th of the run month is paid in full, and one that
 * ends from the 27th to the day before the last day is not paid at all. Neither may pass silently:
 *   - calculatePayrollRun puts RECURRING_NEEDS_PRO_RATA on the employee's line (proRataValidation);
 *   - the approval gate refuses the run (`recurring_needs_pro_rata`, runProRataBlocker) while any of the run's
 *     employees has such a row now, or the run still carries the flag from its calculation (a row changed since,
 *     not yet recalculated: the run's figures are still the old ones).
 * IsaFlow has no per-employee hold, so the refusal is for the whole run, naming each employee. Only lines that read
 * components are judged: a severance-only leaver's line (payrollSeveranceDirective) reads none, so neither the
 * calculation nor the gate looks at that leaver's rows. The fix is the profile's "Edit dates" (PATCH
 * /api/payroll/employees/:id/components?aid=…), then a recalculation.
 * Rows that start or end on other days keep the behaviour they always had (paid in full / not paid) and are not
 * flagged. Once-offs are not flagged: each is paid once in its own month. A voided row (ends before it starts) is
 * never paid and is ignored.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { payrollRunReadDate } from './payrollRunReadDate';
import { getEmployeeComponents } from './payrollComponentService';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { PayrollPeriod, ValidationResult } from './payrollTypes';

export const PRO_RATA_CODE = 'RECURRING_NEEDS_PRO_RATA';

export interface ProRataRow {
  employeeId: string;
  employeeNumber: string;
  componentName: string;
  /** starts after the 27th (paid in full) | ends from the 27th to the day before the last day (not paid) | both (not paid). */
  edge: 'starts' | 'ends' | 'within';
  from: string;
  to: string | null;
  /** A pay package replaced it (superseded_at): Edit dates refuses it, so the flag points at End. */
  superseded?: boolean;
}

/** "starts on 2026-03-28", "ends on 2026-03-30", "starts on 2026-03-28 and ends on 2026-03-29". */
export function describeProRataRow(row: ProRataRow): string {
  if (row.edge === 'starts') return `starts on ${row.from}`;
  if (row.edge === 'ends') return `ends on ${row.to}`;
  return `starts on ${row.from} and ends on ${row.to}`;
}

/**
 * The recurring rows of these employees (in this company) that start or end inside the period's pro-rata band, as
 * the run's reader treats them: a row ending in the band that the reader pays in full (a leaver's last month, Hein)
 * is exempt; one it skips is flagged as ending. The reader is asked directly (getEmployeeComponents at the period's
 * last day), so the guard and the pay cannot disagree about which rows are paid.
 */
export async function recurringRowsNeedingProRata(
  companyId: string,
  period: PayrollPeriod,
  employeeIds: string[],
): Promise<ProRataRow[]> {
  if (employeeIds.length === 0) return [];
  const last = payrollRunReadDate(period);
  const day27 = `${last.slice(0, 8)}27`;
  const rows = (await sql`
    SELECT pec.id, pec.employee_id, e.employee_number, pc.name, pec.effective_from, pec.effective_to, pec.superseded_at,
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
  const paidIds = new Set<string>();
  for (const employeeId of new Set(rows.map((r) => String(r.employee_id)))) {
    for (const c of await getEmployeeComponents(employeeId, companyId, last)) if (c.assignmentId) paidIds.add(c.assignmentId);
  }
  const out: ProRataRow[] = [];
  for (const r of rows) {
    const paid = paidIds.has(String(r.id));
    // Read in full and ending in the band: a leaver's last month (Hein), exempt. Starting in the band and read: paid in
    // full, flagged as starting. Not read: flagged as ending (also when it starts in the band too).
    if (paid && !r.starts) continue;
    out.push({
      employeeId: String(r.employee_id),
      employeeNumber: String(r.employee_number),
      componentName: String(r.name),
      edge: paid ? 'starts' : r.starts ? 'within' : 'ends',
      from: fmtDate(r.effective_from),
      to: r.effective_to ? fmtDate(r.effective_to) : null,
      superseded: r.superseded_at != null,
    });
  }
  return out;
}

/** The line's flag for one such row. A row starting in the band and one ending there are fixed differently. */
export function proRataValidation(row: ProRataRow): ValidationResult {
  const what = `${row.componentName} ${describeProRataRow(row)}`;
  const message = row.edge === 'starts'
    ? `${what}: this recurring component is paid in full in this run and needs a manual pro-rata. Use Edit dates on the `
      + 'employee\'s Pay Components (for example, start it on the 1st of next month and assign the part month as a '
      + 'once-off), then recalculate. Approval is refused until then.'
    : row.superseded
      // A pay package replaced it, and Edit dates refuses a superseded row: End is what is left.
      ? `${what}: this recurring component is not paid at all in this run, though it ran for part of the month, and needs `
        + 'a manual pro-rata. A pay package replaced it: assign the days it ran as a once-off and use End on the '
        + 'employee\'s Pay Components to end it before the 27th; then recalculate. Approval is refused until then.'
      : `${what}: this recurring component is not paid at all in this run, though it ran for part of the month, and needs `
        + 'a manual pro-rata. Assign the days it ran as a once-off and use Edit dates on the employee\'s Pay Components to '
        + 'end it before the 27th, or run it to the month end if the whole month is due; then recalculate. If a once-off '
        + 'of the same component starts the day after it ends, Edit dates cannot run it over that once-off: move that '
        + 'once-off by a day, or end it. Approval is refused until then. (A leaver\'s row ending on their end date is not '
        + 'flagged when their last month pays in full; pro-rate it by hand if due.)';
  return {
    code: PRO_RATA_CODE,
    severity: 'error',
    field: 'components',
    message,
    deepLink: `/payroll/employees/${row.employeeId}#pay-components`,
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
  // The lines that read components: the run's population, not its severance-only leavers (as calculatePayrollRun).
  const reading = new Set((await listPayrollRunEmployees(companyId, period)).map((e) => e.id));
  const live = await recurringRowsNeedingProRata(
    companyId, period, lines.map((l) => String(l.employee_id)).filter((id) => reading.has(id)),
  );
  const liveIds = new Set(live.map((r) => r.employeeId));
  const stale = lines.filter((l) => l.flagged && !liveIds.has(String(l.employee_id))).map((l) => String(l.employee_number));
  if (live.length === 0 && stale.length === 0) return null;
  const parts: string[] = [];
  if (live.length > 0) {
    parts.push('Recurring components start after the 27th or end between the 27th and the last day of the month, so this '
      + 'run pays them in full or not at all; each needs a manual pro-rata: '
      + live.map((r) => `${r.employeeNumber} ${r.componentName} ${describeProRataRow(r)}`).join('; ')
      + '. Use Edit dates on each employee\'s Pay Components, then recalculate.');
  }
  if (stale.length > 0) {
    parts.push(`The run was calculated before the pro-rata was resolved for ${stale.join(', ')}: recalculate it.`);
  }
  return { code: 'recurring_needs_pro_rata', detail: parts.join(' ') };
}
