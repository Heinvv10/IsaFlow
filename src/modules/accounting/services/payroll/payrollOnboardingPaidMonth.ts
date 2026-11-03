/**
 * Onboarding a hire with a salary whose open-ended window would run through a month the company's paid runs already
 * paid: that run never paid it and never will. Judged BEFORE the employee is written (a 4xx commits, so nothing may
 * be written first), under the company's payroll-approval lock, which the request transaction then holds while the
 * employee and the salary are written. Returns the refusal text, or null when the salary may start on `from`.
 */
import { withTransaction } from '@/lib/neon';
import { lockCompanyPayrollForComponentChange, paidPeriodsOf } from './payrollComponentPaidMonths';
import { datedIn } from './payrollOnceOffGuard';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export async function salaryInPaidMonthRefusal(companyId: string, from: string): Promise<string | null> {
  const paid = await withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    return paidPeriodsOf(tx, companyId, null);
  });
  const hit = paid.find((p) => datedIn({ from, to: null }, p));
  if (!hit) return null;
  const latest = paid.reduce((a, b) => (b.year * 12 + b.month > a.year * 12 + a.month ? b : a));
  const next = latest.month === 12 ? { year: latest.year + 1, month: 1 } : { year: latest.year, month: latest.month + 1 };
  const label = `${MONTHS[hit.month - 1]} ${hit.year}`;
  return `${label} is already paid. Set the salary to start ${next.year}-${String(next.month).padStart(2, '0')}-01 `
    + `and pay the ${MONTHS[hit.month - 1]} days as a once-off in an open month.`;
}
