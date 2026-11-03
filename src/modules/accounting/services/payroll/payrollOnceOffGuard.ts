/**
 * What every writer refuses of a row's dates (final payroll breaker, 2026-11-02/03): a once-off that runs past its own
 * month (it is paid once, in that month), and a row, once-off or recurring, dated in a CALENDAR month the company's
 * paid runs already paid (that run will never pay it, whoever it paid; a pre-953 run read the 27th, a post-953 one the
 * last day, so the calendar decides). Edit dates passes the row as it stands and refuses only a month it gains.
 * Used through payrollAssignmentWriteGuard (assign, batch post, package apply) and by Edit dates, under the company
 * lock, before any write.
 */
import type { TxSql } from '@/lib/neon';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { paidNote, paidPeriodsOf, paidRemedyInline, periodLabel, type PaidPeriod } from './payrollComponentPaidMonths';
import { payrollRunReadDate } from './payrollRunReadDate';

/** A once-off must start and end in one month. */
export function refuseOnceOffSpan(from: string, to: string | null): void {
  if (to !== null && to.slice(0, 7) !== from.slice(0, 7)) {
    throw new EmployeeComponentRefused('A once-off must start and end in one month: it is paid once, in that month.');
  }
}

type Window = { from: string; to: string | null };

/** Whether the window is dated in the period's calendar month (first to last day), whatever a run read of it. */
export function datedIn(w: Window, p: PaidPeriod): boolean {
  const last = payrollRunReadDate(p);
  return (w.to === null || w.to >= w.from) && w.from <= last && (w.to === null || w.to >= `${last.slice(0, 8)}01`);
}

/**
 * The first paid month of the COMPANY (not only of this employee: a back-dated row for someone not on the run) the
 * `after` window is dated in and `before` (the same row as it stands, null for a new one) was not.
 */
async function newPaidMonth(
  tx: TxSql, companyId: string, before: Window | null, after: Window, preloaded?: PaidPeriod[],
): Promise<PaidPeriod | undefined> {
  const paid = preloaded ?? await paidPeriodsOf(tx, companyId, null);
  return paid.find((p) => datedIn(after, p) && !(before && datedIn(before, p)));
}

/** A once-off dated in a month a paid run already read: refused, since that run will never pay it. `before`: an edit. */
export async function refuseOnceOffInPaidMonth(
  tx: TxSql, companyId: string, from: string, to: string | null, before: Window | null = null, paid?: PaidPeriod[],
): Promise<void> {
  const hit = await newPaidMonth(tx, companyId, before, { from, to }, paid);
  if (hit) {
    throw new EmployeeComponentRefused(
      `${periodLabel(hit)} is already paid ${paidNote(hit)}: a once-off dated in it would never be paid. Date it in an open month.`);
  }
}

/**
 * A recurring row dated in a paid month it was not already dated in (assign, batch post, package apply: `before` null;
 * Edit dates: the row as it stands). Judged by calendar overlap, so a pre-953 run (read the 27th) and a post-953 one
 * (read the last day) refuse the same dates. Shrinking is left to the employee's own paid runs (paidPeriodChanged).
 */
export async function refuseRecurringInPaidMonth(
  tx: TxSql, companyId: string, before: Window | null, after: Window, paid?: PaidPeriod[],
): Promise<void> {
  const all = paid ?? await paidPeriodsOf(tx, companyId, null);
  const hit = await newPaidMonth(tx, companyId, before, after, all);
  if (hit) {
    // Where to date it from: the month after the latest paid month the row would reach, if the row still runs that far.
    const latest = all.filter((p) => datedIn(after, p)).reduce((a, b) => (b.year * 12 + b.month > a.year * 12 + a.month ? b : a));
    const next = latest.month === 12 ? { year: latest.year + 1, month: 1 } : { year: latest.year, month: latest.month + 1 };
    const nextFirst = `${next.year}-${String(next.month).padStart(2, '0')}-01`;
    const where = after.to !== null && nextFirst > after.to ? 'Date it in an open month' : `Date it from ${nextFirst}`;
    throw new EmployeeComponentRefused(
      `${periodLabel(hit)} is already paid ${paidNote(hit)}: a recurring row dated in it would never be paid for that month. `
      + `${where}; or ${paidRemedyInline(hit)}, or capture the correction in an open period.`);
  }
}
