/**
 * Which months an assignment is paid in, and which of an employee's months are already paid: the facts Edit dates
 * (payrollComponentDateEdit) and End (endEmployeeComponent) need to refuse changing what a paid run paid.
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { payrollRunReadDate } from './payrollRunReadDate';
import { isLockTimeout, setLocalLockTimeout } from './payrollRunLoanApplication';
import type { PayrollPeriod } from './payrollTypes';

export interface AssignmentWindow {
  from: string;
  to: string | null;
  recurring: boolean;
}

/**
 * Whether a run of `period` reads this assignment: getEmployeeComponents' rule (window covers the last day, or a
 * once-off starting in the month), without its supersede check, which depends on the other rows.
 */
export function assignmentReadInPeriod(w: AssignmentWindow, period: PayrollPeriod): boolean {
  const last = payrollRunReadDate(period);
  const first = `${last.slice(0, 8)}01`;
  if (w.to !== null && w.to < w.from) return false;
  if (w.from > last) return false;
  return w.to === null || w.to >= last || (!w.recurring && w.from >= first);
}

/**
 * The months of the employee's lines on runs that have paid: approved or paid, or holding a posted journal (a
 * reopened run whose journal is linked). Company-scoped.
 */
export async function paidPeriodsOf(tx: TxSql, companyId: string, employeeId: string): Promise<PayrollPeriod[]> {
  const rows = (await tx`
    SELECT DISTINCT h.period_year, h.period_month
    FROM payroll_run_headers h
    JOIN payroll_run_lines l ON l.run_id = h.id AND l.employee_id = ${employeeId}::uuid
    WHERE h.company_id = ${companyId}::uuid
      AND (h.status IN ('approved', 'paid') OR h.journal_entry_id IS NOT NULL)
    ORDER BY 1, 2
  `) as DbRow[];
  return rows.map((r) => ({ year: Number(r.period_year), month: Number(r.period_month) }));
}

/** The paid month whose payment this change would alter, or null. */
export function paidPeriodChanged(paid: PayrollPeriod[], before: AssignmentWindow, after: AssignmentWindow): PayrollPeriod | null {
  return paid.find((p) => assignmentReadInPeriod(before, p) !== assignmentReadInPeriod(after, p)) ?? null;
}

export const periodLabel = (p: PayrollPeriod): string => `${p.year}-${String(p.month).padStart(2, '0')}`;

/** An assignment row as the window it is read by. */
export function windowOf(r: DbRow): AssignmentWindow {
  return { from: fmtDate(r.effective_from), to: r.effective_to ? fmtDate(r.effective_to) : null, recurring: r.is_recurring !== false };
}

export class ComponentDatesLockTimeoutError extends Error {
  readonly code = 'PAYROLL_COMPONENT_LOCK_TIMEOUT';
  constructor() {
    super('A payroll run of this company is being approved - retry in a moment.');
    this.name = 'ComponentDatesLockTimeoutError';
  }
}

/**
 * The company's payroll-approval lock (the advisory lock approvePayrollRun takes), held to the end of `tx`, waiting
 * at most 5s: no run of the company is approved while an assignment's dates change, so "already paid" cannot change
 * under the check.
 */
export async function lockCompanyPayrollForComponentChange(tx: TxSql, companyId: string): Promise<void> {
  const previous = await setLocalLockTimeout(tx, '5s');
  try {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll_approval:${companyId}`}, 0))`;
  } catch (err) {
    if (isLockTimeout(err)) throw new ComponentDatesLockTimeoutError();
    throw err;
  }
  await setLocalLockTimeout(tx, previous);
}
