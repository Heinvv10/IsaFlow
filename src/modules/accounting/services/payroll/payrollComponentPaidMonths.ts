/**
 * Which months an assignment is paid in, and which of an employee's months are already paid: the facts Edit dates
 * (payrollComponentDateEdit) and End (endEmployeeComponent) need to refuse changing what a paid run paid.
 */
import type { DbRow, TxSql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { payrollRunReadDate } from './payrollRunReadDate';
import { payrollJournalInForce } from './payrollJournalChain';
import type { PayrollPeriod } from './payrollTypes';
import { paidShareOf } from './payrollRecurringShare';

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
  /** The employee's start date (W29: a share is measured against the employed window). Absent: before any paid period. */
  employeeStart?: string | null;
}

/**
 * A month a paid run read, with when that run was calculated (epoch ms; null before migration 953) and the calculation
 * version it was costed under (null: unstamped).
 */
export type PaidPeriod = PayrollPeriod & {
  calculatedAt?: number | null; reopened?: boolean; version?: number | null;
  /** A weekly or fortnightly run's own dates and frequency (W29 review #1901 R2-L2): the share guard judges its own period. */
  runStart?: string; runEnd?: string; frequency?: string;
};

/** The calculation version from which a run pays a recurring earning by its dates inside the month (W29, wave 7 PRA). */
export const SHARE_BY_DATES_VERSION = 21;

/** How a month was paid, for a refusal: an approved run, or a reopened one whose journal is still posted. */
export const paidNote = (p: PaidPeriod): string => (p.reopened ? '(reopened, but its journal is still posted)' : '(approved run)');
/** What undoes it: a reopened run still counts while its journal stands, so an approved run is reopened AND its journal reversed. */
export const paidRemedy = (p: PaidPeriod): string => (p.reopened ? 'Reverse its journal first' : 'Reopen that run and reverse its journal first');

/** The remedy inside a sentence ("..., or reopen that run ..."): the first letter lower-cased, at the call site. */
export const paidRemedyInline = (p: PaidPeriod): string => paidRemedy(p).replace(/^./, (c) => c.toLowerCase());

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
    SELECT DISTINCT h.period_year, h.period_month, h.status, h.journal_entry_id, h.calculated_at, h.calculation_version,
           h.pay_frequency, to_char(h.period_start, 'YYYY-MM-DD') AS run_start, to_char(h.period_end, 'YYYY-MM-DD') AS run_end
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
        version: r.calculation_version == null ? null : Number(r.calculation_version),
        ...(r.pay_frequency !== 'monthly' && r.run_start && r.run_end ? { runStart: String(r.run_start), runEnd: String(r.run_end), frequency: String(r.pay_frequency) } : {}),
      });
    }
  }
  return paid;
}

/**
 * W29 (review #1901 M3, R2-H1): a run of version 21 or later paid a recurring row by its dates (payrollRecurringShare).
 * A move changes what that run paid only when the row's share of the run's employed window changes: cutting a row to the
 * paid month's last day, or a package from the 1st of the next month, leaves the share whole and is allowed; ending it on
 * the 20th is refused. Judged for every recurring row (the window does not say whether it is an apportioned earning):
 * refuses more, never less. A weekly or fortnightly run is judged on its own dates (R2-L2), whatever its EMP201 month.
 */
function shareDateMoved(p: PaidPeriod, before: AssignmentWindow, after: AssignmentWindow): boolean {
  if (p.version == null || p.version < SHARE_BY_DATES_VERSION || !before.recurring || !after.recurring) return false;
  const period: PayrollPeriod = p.runStart && p.runEnd ? { year: p.year, month: p.month, start: p.runStart, end: p.runEnd } : { year: p.year, month: p.month };
  const frequency = p.runStart && p.runEnd && (p.frequency === 'weekly' || p.frequency === 'fortnightly') ? p.frequency : 'monthly';
  const paidShare = (w: AssignmentWindow) => paidShareOf(frequency, period, { effectiveFrom: w.from, effectiveTo: w.to }, {
    startDate: new Date(`${w.employeeStart ?? '1900-01-01'}T00:00:00Z`), endDate: w.employeeEnd ? new Date(`${w.employeeEnd}T00:00:00Z`) : null,
  });
  return paidShare(before) !== paidShare(after);
}

/** The paid month whose payment this change would alter, or null. */
export function paidPeriodChanged(paid: PaidPeriod[], before: AssignmentWindow, after: AssignmentWindow): PaidPeriod | null {
  return paid.find((p) => assignmentReadInPeriod(before, p) !== assignmentReadInPeriod(after, p) || shareDateMoved(p, before, after)) ?? null;
}

export const periodLabel = (p: PayrollPeriod): string => `${p.year}-${String(p.month).padStart(2, '0')}`;

/** An assignment row as the window it is read by. */
export function windowOf(r: DbRow): AssignmentWindow {
  return {
    from: fmtDate(r.effective_from), to: r.effective_to ? fmtDate(r.effective_to) : null,
    recurring: r.is_recurring !== false, legacy: r.supersede_inferred === true,
    employeeEnd: r.employee_end ? fmtDate(r.employee_end) : null,
    employeeStart: r.employee_start ? fmtDate(r.employee_start) : null,
    supersededAt: r.superseded_at == null ? null : new Date(r.superseded_at as string | Date).getTime(),
  };
}

export { ComponentDatesLockTimeoutError, lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
