/**
 * Which months an assignment is paid in, and which of an employee's months are already paid: the facts Edit dates
 * (payrollComponentDateEdit) and End (endEmployeeComponent) need to refuse changing what a paid run paid.
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { payrollRunReadDate } from './payrollRunReadDate';
import { isLockTimeout, setLocalLockTimeout } from './payrollRunLoanApplication';
import { payrollJournalInForce } from './payrollJournalChain';
import type { PayrollPeriod } from './payrollTypes';

export interface AssignmentWindow {
  from: string;
  to: string | null;
  recurring: boolean;
  /** superseded_at (migration 953) in epoch ms: when a package apply cut it. Null: never cut. */
  supersededAt?: number | null;
  /** Existed before 953: the neighbour rule still decides its supersede (payrollComponentDateEdit). */
  legacy?: boolean;
}

/** A month a paid run read, with when that run was calculated (epoch ms; null before migration 953). */
export type PaidPeriod = PayrollPeriod & { calculatedAt?: number | null };

/**
 * Whether a run of `period` reads (or, for a paid run, READ) this assignment: getEmployeeComponents' rule, row by
 * row. A supersede counts only if it happened before the run was calculated: a row cut after a paid run read it was
 * still read by that run (security review, 2026-11-02). Without a calculation time the supersede is taken as later.
 */
export function assignmentReadInPeriod(w: AssignmentWindow, period: PaidPeriod): boolean {
  const last = payrollRunReadDate(period);
  const first = `${last.slice(0, 8)}01`;
  if (w.to !== null && w.to < w.from) return false;
  if (w.from > last) return false;
  const cutBefore = w.supersededAt != null && period.calculatedAt != null && w.supersededAt <= period.calculatedAt;
  return w.to === null || w.to >= last || (!w.recurring && !cutBefore && w.from >= first);
}

/**
 * The months of the employee's lines on runs that have paid: approved or paid, or reopened while the journal they
 * posted is still in force in the ledger (its reversal chain, payrollJournalChain). A reopened run whose journal was
 * reversed keeps the link but has not paid (M1). Company-scoped.
 */
export async function paidPeriodsOf(tx: TxSql, companyId: string, employeeId: string): Promise<PaidPeriod[]> {
  const rows = (await tx`
    SELECT h.period_year, h.period_month, h.status, h.journal_entry_id, h.calculated_at
    FROM payroll_run_headers h
    JOIN payroll_run_lines l ON l.run_id = h.id AND l.employee_id = ${employeeId}::uuid
    WHERE h.company_id = ${companyId}::uuid
      AND (h.status IN ('approved', 'paid') OR h.journal_entry_id IS NOT NULL)
    ORDER BY 1, 2
  `) as DbRow[];
  const paid: PaidPeriod[] = [];
  for (const r of rows) {
    const approved = r.status === 'approved' || r.status === 'paid';
    if (approved || await payrollJournalInForce(companyId, String(r.journal_entry_id), tx)) {
      paid.push({
        year: Number(r.period_year), month: Number(r.period_month),
        calculatedAt: r.calculated_at == null ? null : new Date(r.calculated_at as string | Date).getTime(),
      });
    }
  }
  return paid;
}

/** The paid month whose payment this change would alter, or null. */
export function paidPeriodChanged(paid: PaidPeriod[], before: AssignmentWindow, after: AssignmentWindow): PaidPeriod | null {
  return paid.find((p) => assignmentReadInPeriod(before, p) !== assignmentReadInPeriod(after, p)) ?? null;
}

export const periodLabel = (p: PayrollPeriod): string => `${p.year}-${String(p.month).padStart(2, '0')}`;

/** An assignment row as the window it is read by. */
export function windowOf(r: DbRow): AssignmentWindow {
  return {
    from: fmtDate(r.effective_from), to: r.effective_to ? fmtDate(r.effective_to) : null,
    recurring: r.is_recurring !== false, legacy: r.supersede_inferred === true,
    supersededAt: r.superseded_at == null ? null : new Date(r.superseded_at as string | Date).getTime(),
  };
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
