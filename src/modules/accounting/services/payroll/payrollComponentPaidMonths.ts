/**
 * Which months an assignment is paid in, and which of an employee's months are already paid: the facts Edit dates
 * (payrollComponentDateEdit) and End (endEmployeeComponent) need to refuse changing what a paid run paid.
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { payrollRunReadDate } from './payrollRunReadDate';
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
  /** The employee's end date: a recurring row ending on it is read for that whole month (Hein 2026-11-02). */
  employeeEnd?: string | null;
}

/** A month a paid run read, with when that run was calculated (epoch ms; null before migration 953). */
export type PaidPeriod = PayrollPeriod & { calculatedAt?: number | null; reopened?: boolean };

/** How a month was paid, for a refusal: an approved run, or a reopened one whose journal is still posted. */
export const paidNote = (p: PaidPeriod): string => (p.reopened ? '(reopened, but its journal is still posted)' : '(approved run)');
/** What undoes it: a reopened run still counts while its journal stands, so an approved run is reopened AND its journal reversed. */
export const paidRemedy = (p: PaidPeriod): string => (p.reopened ? 'Reverse its journal first' : 'Reopen that run and reverse its journal first');

/**
 * Whether a run of `period` reads (or, for a paid run, READ) this assignment: getEmployeeComponents' rule, row by
 * row. A supersede counts only if it happened before the run was calculated: a row cut after a paid run read it was
 * still read by that run (security review, 2026-11-02). Without a calculation time the supersede is taken as later.
 */
export function assignmentReadInPeriod(w: AssignmentWindow, period: PaidPeriod): boolean {
  const last = payrollRunReadDate(period);
  const first = `${last.slice(0, 8)}01`;
  if (w.to !== null && w.to < w.from) return false;
  // A run calculated before migration 953 read every row on the 27th (the old day 28 through toISOString in SAST).
  if (period.calculatedAt === null) {
    const day27 = `${last.slice(0, 8)}27`;
    return w.from <= day27 && (w.to === null || w.to >= day27);
  }
  if (w.from > last) return false;
  // A leaver's row ending on their end date in the band (getEmployeeComponents); a recurring successor row is not
  // visible here, so this may say "read" where the run did not: it refuses more, never less.
  if (w.recurring && w.to !== null && w.to === w.employeeEnd && w.to >= `${last.slice(0, 8)}27`) return true;
  const cutBefore = w.supersededAt != null && period.calculatedAt != null && w.supersededAt <= period.calculatedAt;
  return w.to === null || w.to >= last || (!w.recurring && !cutBefore && w.from >= first);
}

/**
 * The months of the employee's lines on runs that have paid: approved or paid, or reopened while the journal they
 * posted is still in force in the ledger (its reversal chain, payrollJournalChain). A reopened run whose journal was
 * reversed keeps the link but has not paid (M1). Company-scoped.
 */
export async function paidPeriodsOf(tx: TxSql, companyId: string, employeeId: string | null): Promise<PaidPeriod[]> {
  // employeeId null: every paid month of the company, whoever its run paid (a once-off back-dated into it would never
  // be paid by that run, line or not).
  const rows = (await tx`
    SELECT DISTINCT h.period_year, h.period_month, h.status, h.journal_entry_id, h.calculated_at
    FROM payroll_run_headers h
    WHERE h.company_id = ${companyId}::uuid
      AND (h.status IN ('approved', 'paid') OR h.journal_entry_id IS NOT NULL)
      AND (${employeeId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM payroll_run_lines l WHERE l.run_id = h.id AND l.employee_id = ${employeeId}::uuid))
    ORDER BY 1, 2
  `) as DbRow[];
  const paid: PaidPeriod[] = [];
  for (const r of rows) {
    const approved = r.status === 'approved' || r.status === 'paid';
    if (approved || await payrollJournalInForce(companyId, String(r.journal_entry_id), tx)) {
      paid.push({
        year: Number(r.period_year), month: Number(r.period_month),
        calculatedAt: r.calculated_at == null ? null : new Date(r.calculated_at as string | Date).getTime(), reopened: !approved,
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
    employeeEnd: r.employee_end ? fmtDate(r.employee_end) : null,
    supersededAt: r.superseded_at == null ? null : new Date(r.superseded_at as string | Date).getTime(),
  };
}

export { ComponentDatesLockTimeoutError, lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
