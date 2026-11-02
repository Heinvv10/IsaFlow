/**
 * What every writer refuses of a once-off (final payroll breaker, 2026-11-02), as Edit dates does: a window that runs
 * past its own month (it is paid once, in that month), and a date in a month a paid run already read (that run would
 * never pay it). Used by assign, batch post and package apply, under the company lock, before any write.
 */
import type { TxSql } from '@/lib/neon';
import { EmployeeComponentRefused } from './payrollEmployeeComponentRefused';
import { assignmentReadInPeriod, paidPeriodsOf, periodLabel } from './payrollComponentPaidMonths';

/** A once-off must start and end in one month. */
export function refuseOnceOffSpan(from: string, to: string | null): void {
  if (to !== null && to.slice(0, 7) !== from.slice(0, 7)) {
    throw new EmployeeComponentRefused('A once-off must start and end in one month: it is paid once, in that month.');
  }
}

/** A once-off a paid run would have read: refused, since that run will never pay it. */
export async function refuseOnceOffInPaidMonth(
  tx: TxSql, companyId: string, employeeId: string, from: string, to: string | null,
): Promise<void> {
  const paid = await paidPeriodsOf(tx, companyId, employeeId);
  const hit = paid.find((p) => assignmentReadInPeriod({ from, to, recurring: false }, { ...p, calculatedAt: undefined }));
  if (hit) {
    throw new EmployeeComponentRefused(
      `${periodLabel(hit)} is already paid (approved run): a once-off dated in it would never be paid. Date it in an open month.`);
  }
}
