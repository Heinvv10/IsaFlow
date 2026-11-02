/**
 * The ONE place an assignment's dates change after it was assigned: Edit dates (PATCH
 * /api/payroll/employees/:id/components?aid=…, the Pay Components card) and End (DELETE …, MCP
 * end_employee_component, via endEmployeeComponent). Edit dates is how a run refused for a manual pro-rata
 * (payrollRecurringProRata) is fixed.
 *
 * In one transaction: the company's payroll-approval lock (as approvePayrollRun takes it, bounded at 5s), so no run is
 * approved while the row changes; then the row and its siblings (same employee and component) FOR UPDATE inside the
 * company. Refused before any write (EmployeeComponentRefused, a 400):
 *   - a voided row (cancelled);
 *   - Edit: a non-date, an end before the start, a once-off open-ended or spanning more than one month;
 *   - End: an end before the start of a row a paid run read, or later than the current end (End only shortens;
 *     Edit dates extends); a cancel of a row a paid run read;
 *   - a window overlapping another live sibling (both would be paid);
 *   - a change to what a paid run paid (payrollComponentPaidMonths);
 *   - Edit: a once-off dated in a month any approved run of the company read, or a recurring row gaining such a month
 *     (judged company-wide, not only on the employee's own lines: that run will never pay it).
 * End CANCELS (voids: effective_to = effective_from - 1, the shape the reader never pays) an assignment no paid run
 * read when it is a once-off, when the end date is before its start, or when the caller asks to cancel (MCP `cancel`).
 * Since migration 953 a supersede is recorded (superseded_at) instead of inferred from a neighbour, so moving or ending
 * a neighbour cannot revive a replaced once-off. Rows that existed before 953 (supersede_inferred) keep the neighbour
 * rule in the reader, so for them a change that flips a pre-953 once-off's inferred supersede (revives it, or drops it)
 * is refused.
 * Every accepted change is written to audit_log (entity payroll_employee_component: effective_from and effective_to
 * before and after; metadata kind edit | end | cancel and the channel) in the same transaction; the approval gate
 * refuses a run calculated before such a change. Logs and audit rows carry ids and the window only, never the amount.
 * False when the id matches no assignment in the company.
 */
import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isRealCalendarDate, isUuidParam } from '@/lib/validation';
import { auditComponentChange, type ComponentChangeActor } from './payrollComponentAudit';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { refuseOnceOffInPaidMonth } from './payrollOnceOffGuard';
import type { PayrollPeriod } from './payrollTypes';
import { legacyFlips, live, shiftDay, type Sibling } from './payrollComponentLegacySupersede';
import {
  assignmentReadInPeriod, lockCompanyPayrollForComponentChange, paidPeriodChanged, paidPeriodsOf, periodLabel, windowOf,
  type AssignmentWindow,
} from './payrollComponentPaidMonths';

export type { ComponentChangeActor } from './payrollComponentAudit';
export type DateChange = { kind: 'edit'; from: string; to: string | null } | { kind: 'end'; to: string; cancel?: boolean };

/** The window alone: what may be logged or audited. Never the amount (an employee's pay). */
const windowOnly = (w: AssignmentWindow): AssignmentWindow => ({
  from: w.from, to: w.to, recurring: w.recurring, supersededAt: w.supersededAt, legacy: w.legacy, employeeEnd: w.employeeEnd,
});

function refuse(message: string): never {
  throw new EmployeeComponentRefused(message);
}

function validateRequest(change: DateChange): void {
  if (change.kind === 'edit') {
    if (!isRealCalendarDate(change.from)) refuse('effectiveFrom must be a real date (YYYY-MM-DD)');
    if (change.to !== null && !isRealCalendarDate(change.to)) refuse('effectiveTo must be a real date (YYYY-MM-DD), or empty for open-ended');
    if (change.to !== null && change.to < change.from) refuse('effectiveTo cannot be before effectiveFrom');
  } else if (!isRealCalendarDate(change.to)) {
    refuse('effectiveTo must be a real date (YYYY-MM-DD)');
  }
}

/** The window after the change, and whether it is a cancel. Refuses what the change itself may not do. */
function nextWindow(before: AssignmentWindow, change: DateChange, paidIn: PayrollPeriod | null): { after: AssignmentWindow; kind: 'edit' | 'end' | 'cancel' } {
  if (!live(before)) refuse('This assignment was cancelled (its end is before its start) and cannot be changed; assign a new one.');
  if (change.kind === 'edit') {
    if (before.supersededAt != null) {
      refuse('A pay package replaced this assignment (it is superseded); edit the assignment that replaced it instead.');
    }
    // The row's own facts (supersede, pre-953 marker, the employee's end date) stay: only the dates change.
    const after = { ...windowOnly(before), from: change.from, to: change.to };
    if (!after.recurring && after.to === null) refuse('A once-off needs an end date: it is paid once, in its own month.');
    if (!after.recurring && after.to !== null && after.to.slice(0, 7) !== after.from.slice(0, 7)) {
      refuse('A once-off must start and end in one month: it is paid once, in that month.');
    }
    return { after, kind: 'edit' };
  }
  if (change.cancel && paidIn) {
    refuse(`This assignment was already paid in ${periodLabel(paidIn)} (approved run), so it cannot be cancelled; end it with a date instead.`);
  }
  if (!paidIn && (!before.recurring || change.cancel || change.to < before.from)) {
    return { after: { ...windowOnly(before), to: shiftDay(before.from, -1) }, kind: 'cancel' };
  }
  if (change.to < before.from) refuse(`The end (${change.to}) is before its start (${before.from}), and a paid run read it; change its dates with Edit dates.`);
  if (before.to !== null && change.to > before.to) {
    refuse(`End can only bring the end date earlier (it is ${before.to}); use Edit dates to extend it.`);
  }
  return { after: { ...windowOnly(before), to: change.to }, kind: 'end' };
}

export async function changeAssignmentDates(
  companyId: string,
  assignmentId: string,
  change: DateChange,
  actor: ComponentChangeActor,
): Promise<boolean> {
  validateRequest(change);
  if (!isUuidParam(assignmentId)) return false;

  return withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    const target = ((await tx`
      SELECT pec.id, pec.employee_id, pec.component_id
      FROM payroll_employee_components pec
      JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
      WHERE pec.id = ${assignmentId}::uuid
    `) as DbRow[])[0];
    if (!target) return false;
    const rows = (await tx`
      SELECT id, effective_from, effective_to, is_recurring, superseded_at, supersede_inferred,
             (SELECT end_date FROM payroll_employees WHERE id = employee_id) AS employee_end
        FROM payroll_employee_components
      WHERE employee_id = ${target.employee_id}::uuid AND component_id = ${target.component_id}::uuid
      ORDER BY id FOR UPDATE
    `) as DbRow[];
    const siblings: Sibling[] = rows.map((r) => ({ ...windowOf(r), id: String(r.id) }));
    const self = siblings.find((r) => r.id === assignmentId)!;
    const paid = await paidPeriodsOf(tx, companyId, String(target.employee_id));
    const { after, kind } = nextWindow(self, change, paid.find((p) => assignmentReadInPeriod(self, p)) ?? null);

    if (kind === 'edit') {
      // Company-wide, as assign, batch and package judge: a run the employee is not on will never pay a row moved into
      // its month. A once-off may not be dated in a paid month; a recurring row may not gain one.
      if (!after.recurring) await refuseOnceOffInPaidMonth(tx, companyId, after.from, after.to);
      if (after.recurring) {
        const added = (await paidPeriodsOf(tx, companyId, null)).find((p) => assignmentReadInPeriod(after, p) && !assignmentReadInPeriod(self, p));
        if (added) {
          refuse(`${periodLabel(added)} is already paid (approved run): this would add that month to the row, and that run will never pay it. `
            + 'Reopen that run first, or capture the correction in an open period.');
        }
      }
    }
    if (kind !== 'cancel') {
      const clash = siblings.find((y) => y.id !== self.id && live(y) && y.from <= (after.to ?? '9999-12-31') && (y.to === null || y.to >= after.from));
      if (clash) {
        refuse(`These dates overlap the employee's other assignment of this component (${clash.from} to ${clash.to ?? 'open-ended'}): `
          + 'both would be paid. Change or end that one first.');
      }
    }
    const changed = paidPeriodChanged(paid, self, after);
    if (changed) {
      refuse(`${periodLabel(changed)} is already paid (approved run) and this changes what it paid. `
        + 'Reopen that run first, or capture the correction in an open period.');
    }
    const [flip] = legacyFlips(siblings, siblings.map((r) => (r.id === self.id ? { ...r, ...after } : r)));
    if (flip) {
      refuse(`This would make the once-off ${flip.row.from} to ${flip.row.to} ${flip.paidAgain ? 'be paid again' : 'stop being paid'}: `
        + 'before this release it was replaced by an assignment starting the day after it ends. Cancel or change that once-off first.');
    }

    await tx`
      UPDATE payroll_employee_components SET effective_from = ${after.from}::date, effective_to = ${after.to}::date
      WHERE id = ${assignmentId}::uuid
    `;
    await auditComponentChange(tx, companyId, assignmentId, windowOnly(self), windowOnly(after), kind, actor);
    log.info('Changed employee component dates', {
      companyId, assignmentId, kind, before: windowOnly(self), after: windowOnly(after),
    }, 'payrollComponentDateEdit');
    return true;
  });
}

/** Edit dates: both dates, on an open or ended row. */
export function updateEmployeeComponentDates(
  companyId: string, assignmentId: string, effectiveFrom: string, effectiveTo: string | null, actor: ComponentChangeActor,
): Promise<boolean> {
  return changeAssignmentDates(companyId, assignmentId, { kind: 'edit', from: effectiveFrom, to: effectiveTo }, actor);
}
