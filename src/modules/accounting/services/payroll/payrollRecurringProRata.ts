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
 * flagged. W29 (wave 7 PRA, rulings 7, 13, 19): a recurring EARNING with a plain amount that starts or ends strictly inside
 * employment is now paid its share of the period (payrollRecurringShare), so it is not flagged either; the guard still
 * flags a starter's or leaver's own row in the band, a deduction, and an hours, percent-of-RFI or defined-benefit row. Once-offs are not flagged: each is paid once in its own month. A voided row (ends before it starts) is
 * never paid and is ignored.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { payrollRunReadDate } from './payrollRunReadDate';
import { insideEmploymentEdge, isApportionable, isMonthlyPeriod, periodBoundsOf } from './payrollRecurringShare';
import { runShareAckBlocker } from './payrollRecurringShareAck';
import { overlappingRecurringRows } from './payrollRecurringOverlap';
import { getEmployeeComponents, recurringEarningsEndedInPeriod } from './payrollComponentService';
import { listPayrollRunEmployees } from './payrollEmployeeService';
import { payFrequencyOf, runPeriodOf } from './payrollFrequency';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import type { EmployeeComponent, PayrollPeriod, ValidationResult } from './payrollTypes';

export const PRO_RATA_CODE = 'RECURRING_NEEDS_PRO_RATA';

export interface ProRataRow {
  employeeId: string;
  employeeNumber: string;
  componentName: string;
  /**
   * starts after the 27th (paid in full) | ends from the 27th to the day before the last day (not paid) | both (not paid) |
   * after_end: a recurring earning starting after the employee's last day (not paid; review #1901 round 3) |
   * overlap: it overlaps another live recurring row of its component (both paid for those days; round 4).
   */
  edge: 'starts' | 'ends' | 'within' | 'after_end' | 'overlap';
  from: string;
  to: string | null;
  /** A pay package replaced it (superseded_at): Edit dates refuses it, so the flag points at End. */
  superseded?: boolean;
}

/** "starts on 2026-03-28", "ends on 2026-03-30", "starts on 2026-03-28 and ends on 2026-03-29". */
export function describeProRataRow(row: ProRataRow): string {
  if (row.edge === 'starts') return `starts on ${row.from}`;
  if (row.edge === 'after_end') return `starts on ${row.from}, after the employee's last day`;
  if (row.edge === 'overlap') return `starts on ${row.from}, overlapping another of its rows`;
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
  // The band: from the 27th of a month (Hein 2026-11-02); a weekly or fortnightly run's whole period (wave 6 FQc), since
  // it reads on its own last day and does not apportion either: a row starting after its first day is paid in full, one
  // ending before its last day is not paid.
  const day27 = period.start ?? `${last.slice(0, 8)}27`;
  const { start: periodStart } = periodBoundsOf(period);
  const rows = (await sql`
    SELECT pec.id, pec.employee_id, pec.component_id, e.employee_number, pc.name, pec.effective_from, pec.effective_to, pec.superseded_at,
           pec.effective_from > ${day27}::date AS starts,
           pc.component_type, pec.quantity, pec.percent_of_rfi, pec.db_member_category_factor, e.start_date, e.end_date
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
        -- Review #1901 round 3: a leaver's own row ending on their end date anywhere in the period (both readers judge it
        -- by one successor predicate), and a row starting after their last day inside the period.
        OR (e.end_date IS NOT NULL AND pec.effective_to = e.end_date AND pec.effective_to >= ${periodStart}::date AND pec.effective_to < ${last}::date)
        OR (e.end_date IS NOT NULL AND pec.effective_from > e.end_date AND pec.effective_from >= ${periodStart}::date AND pec.effective_from <= ${last}::date)
      )
    ORDER BY e.employee_number, pc.name, pec.effective_from
  `) as DbRow[];
  const paidIds = new Set<string>();
  // W29: the rows the run reads as having ended inside employment (payrollRecurringShareRead), so the guard and the pay
  // agree on which rows the share pays: a package-cut row replaced by a once-off is not among them, and stays flagged.
  const endedIds = new Set<string>();
  // Option B (#1901): the components either reader pays, per employee, to find a half-paid monthly leaver (below). A
  // recurring row starting after the last day is not paid (apportionRecurringRows), so it pays nothing beside the row.
  const readComponents = new Set<string>();
  const monthly = isMonthlyPeriod(period);
  const lastDayOf = new Map(rows.map((r) => [String(r.employee_id), r.end_date == null ? null : fmtDate(r.end_date)]));
  const paysBeside = (employeeId: string, c: EmployeeComponent) => {
    const lastDay = lastDayOf.get(employeeId);
    if (!(c.isRecurring && lastDay != null && c.effectiveFrom !== undefined && c.effectiveFrom > lastDay)) readComponents.add(`${employeeId}:${c.component.id}`);
  };
  for (const employeeId of new Set(rows.map((r) => String(r.employee_id)))) {
    for (const c of await getEmployeeComponents(employeeId, companyId, last)) {
      if (c.assignmentId) paidIds.add(c.assignmentId);
      paysBeside(employeeId, c);
    }
    for (const c of await recurringEarningsEndedInPeriod(employeeId, companyId, periodStart, last, !monthly)) {
      if (c.assignmentId) endedIds.add(c.assignmentId);
      paysBeside(employeeId, c);
    }
  }
  const out: ProRataRow[] = [];
  for (const r of rows) {
    // W29: a recurring earning starting or ending inside employment is paid its share (payrollRecurringShare): not flagged.
    if ((paidIds.has(String(r.id)) || endedIds.has(String(r.id))) && sharePays(period, r)) continue;
    // A row either reader reads is paid (review #1901 round 3: a weekly leaver row the ended-rows reader pays whole).
    const paid = (paidIds.has(String(r.id)) || endedIds.has(String(r.id))) && !startsAfterEnd(r);
    if (startsAfterEnd(r)) {
      out.push({ employeeId: String(r.employee_id), employeeNumber: String(r.employee_number), componentName: String(r.name), edge: 'after_end',
        from: fmtDate(r.effective_from), to: r.effective_to ? fmtDate(r.effective_to) : null, superseded: r.superseded_at != null });
      continue;
    }
    // Option B (coordinator ruling on #1901, 2026-11-26; Hein 2026-11-02): a monthly leaver's own row ending before the 27th
    // is not paid and not flagged, as on master (the part month is entered by hand), unless another row of its component
    // IS paid this month (a raise on the 10th paid at its share): that leaver would be half paid, so the row is flagged
    // and approval refused, never silently underpaid.
    if (!paid && monthly && r.end_date != null && r.effective_to != null && fmtDate(r.effective_to) === fmtDate(r.end_date)
      && fmtDate(r.effective_to) < day27 && !readComponents.has(`${String(r.employee_id)}:${String(r.component_id)}`)) continue;
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
  // Round 4: two live recurring rows of one component overlapping in the period are both paid for the shared days.
  for (const o of await overlappingRecurringRows(companyId, employeeIds, periodStart, last)) {
    out.push({ employeeId: o.employeeId, employeeNumber: o.employeeNumber, componentName: o.componentName, edge: 'overlap', from: o.from, to: o.to });
  }
  return out;
}

/** A recurring earning with a plain amount, as a stored row (the guard's mapping of isApportionable; round 4: one helper). */
function apportionableRow(r: DbRow): boolean {
  return isApportionable({ component: { componentType: String(r.component_type) }, isRecurring: true,
    quantity: r.quantity == null ? null : Number(r.quantity), percentOfRfi: r.percent_of_rfi == null ? null : Number(r.percent_of_rfi),
    dbMemberCategoryFactor: r.db_member_category_factor == null ? null : Number(r.db_member_category_factor) });
}

/** A recurring earning (plain amount) that starts after the employee's last day: the run does not pay it (apportionRecurringRows). */
function startsAfterEnd(r: DbRow): boolean {
  return r.end_date != null && fmtDate(r.effective_from) > fmtDate(r.end_date) && apportionableRow(r);
}

/** The run apportions this row when it reads it (W29): the same predicate the run's reading applies (payrollRecurringShareRead). */
export function sharePays(period: PayrollPeriod, r: DbRow): boolean {
  if (!apportionableRow(r)) return false;
  return insideEmploymentEdge(period, { effectiveFrom: fmtDate(r.effective_from), effectiveTo: r.effective_to ? fmtDate(r.effective_to) : null },
    { startDate: new Date(`${fmtDate(r.start_date)}T00:00:00Z`), endDate: r.end_date ? new Date(`${fmtDate(r.end_date)}T00:00:00Z`) : null });
}

/** The line's flag for one such row. A row starting in the band and one ending there are fixed differently. */
export function proRataValidation(row: ProRataRow): ValidationResult {
  const what = `${row.componentName} ${describeProRataRow(row)}`;
  const message = row.edge === 'overlap'
    ? `${what}: two recurring rows of this component overlap, so both are paid for the shared days. Use Edit dates on the `
      + 'employee\'s Pay Components so one ends before the other starts, then recalculate. Approval is refused until then.'
    : row.edge === 'after_end'
    ? `${what}: this recurring earning starts after the employee left, so this run does not pay it. Use Edit dates or End `
      + 'on the employee\'s Pay Components to correct or remove it (pay anything due as a once-off), then recalculate. '
      + 'Approval is refused until then.'
    : row.edge === 'starts'
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

/** The approval refusal for the run (pro-rata first, then an unacknowledged share beside a once-off), or null (always for an off-cycle run). Read-only. */
export async function runProRataBlocker(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const lines = (await sql`
    SELECT l.employee_id, e.employee_number, h.period_year, h.period_month, h.pay_frequency, h.period_start, h.period_end, h.run_kind,
           jsonb_path_exists(l.validation_results, ${`$[*] ? (@.code == "${PRO_RATA_CODE}")`}::jsonpath) AS flagged
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id AND h.company_id = ${companyId}::uuid
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid
    ORDER BY e.employee_number
  `) as DbRow[];
  const head = lines[0];
  // An off-cycle run pays no recurring component (calculatePayrollRun skips them), so nothing here can change its lines
  // (gate ruling 4 on e0eec1dea1): the same exemption at approval as at calculation.
  if (!head || head.run_kind === 'off_cycle') return null;
  const period = runPeriodOf(head);
  // The lines that read components: the run's population, not its severance-only leavers (as calculatePayrollRun).
  const reading = new Set((await listPayrollRunEmployees(companyId, period, payFrequencyOf(head.pay_frequency))).map((e) => e.id));
  const live = await recurringRowsNeedingProRata(
    companyId, period, lines.map((l) => String(l.employee_id)).filter((id) => reading.has(id)),
  );
  const liveIds = new Set(live.map((r) => r.employeeId));
  const stale = lines.filter((l) => l.flagged && !liveIds.has(String(l.employee_id))).map((l) => String(l.employee_number));
  // W29 (review #1901 M2): with no row left to pro-rate, a share beside a once-off earning still waits for its acknowledgement.
  if (live.length === 0 && stale.length === 0) return runShareAckBlocker(companyId, runId);
  const parts: string[] = [];
  if (live.length > 0) {
    // Round 4: one lead sentence true for every edge (a late start or end, an after-the-last-day start, a leaver's end-date
    // row on any day, an overlap).
    parts.push('Recurring components on this run would be paid in full, not at all, or twice for some days, and need '
      + 'their dates corrected: '
      + live.map((r) => `${r.employeeNumber} ${r.componentName} ${describeProRataRow(r)}`).join('; ')
      + '. Use Edit dates on each employee\'s Pay Components, then recalculate.');
  }
  if (stale.length > 0) {
    parts.push(`The run was calculated before the pro-rata was resolved for ${stale.join(', ')}: recalculate it.`);
  }
  return { code: 'recurring_needs_pro_rata', detail: parts.join(' ') };
}
