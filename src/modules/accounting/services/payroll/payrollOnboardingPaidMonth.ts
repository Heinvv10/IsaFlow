/**
 * Onboarding a hire with a salary whose open-ended window would run through a month the company's paid runs already
 * paid: that run never paid it and never will. Judged BEFORE the employee is written (a 4xx commits, so nothing may
 * be written first), under the company's payroll-approval lock, which the request transaction then holds while the
 * employee and the salary are written. Returns the refusal text, or null when the salary may start on `from`.
 */
import { withTransaction } from '@/lib/neon';
import { lockCompanyPayrollForComponentChange, paidPeriodsOf } from './payrollComponentPaidMonths';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
type Period = { year: number; month: number };

const indexOf = (p: Period): number => p.year * 12 + p.month - 1;
const periodOf = (i: number): Period => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });
const joined = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** "February 2026", "January, February and March 2026", or "December 2025 and January 2026" across a year end. */
function monthsText(indexes: number[]): string {
  const ps = indexes.map(periodOf);
  if (ps.every((p) => p.year === ps[0]!.year)) return `${joined(ps.map((p) => MONTHS[p.month - 1]!))} ${ps[0]!.year}`;
  return joined(ps.map((p) => `${MONTHS[p.month - 1]} ${p.year}`));
}

/**
 * The refusal for a salary starting `from` (ending `to`, or open-ended), or null when no paid month falls in its
 * window. Names every month from the start through the latest paid month in the window: the paid ones, and the open
 * ones between (a salary cannot start in an open month that a later paid month runs through). The salary moves to
 * the month after; when the end date leaves no such month, the advice is once-offs and no salary.
 */
export function salaryPaidMonthText(paid: Period[], from: string, to: string | null = null): string | null {
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  const end = to === null ? Infinity : Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)) - 1;
  const paidIdx = new Set(paid.map(indexOf));
  const latest = Math.max(-1, ...[...paidIdx].filter((i) => i <= end));
  if (latest < start) return null;
  const all = Array.from({ length: latest - start + 1 }, (_, k) => start + k);
  const gaps = all.filter((i) => !paidIdx.has(i));
  const paidHere = all.filter((i) => paidIdx.has(i));
  const next = periodOf(latest + 1);
  const nextFirst = `${next.year}-${String(next.month).padStart(2, '0')}-01`;
  const sameYear = all.every((i) => periodOf(i).year === periodOf(all[0]!).year);
  const names = sameYear ? joined(all.map((i) => MONTHS[periodOf(i).month - 1]!)) : joined(all.map((i) => monthsText([i])));
  const first = paidHere.length === 1 ? `${monthsText(paidHere)} is` : `${monthsText(paidHere)} are`;
  const because = gaps.length ? `, so ${monthsText(gaps)} cannot start the salary either` : '';
  const pay = all.length === 1 ? `the ${names} days as a once-off` : gaps.length ? `the ${names} days as once-offs` : 'those days as once-offs';
  if (to !== null && nextFirst > to) {
    return `${first} already paid${because}. The end date ${to} leaves no open month for the salary: pay ${pay} in an open month and create the employee without a salary.`;
  }
  return `${first} already paid${because}. Set the salary to start ${nextFirst} and pay ${pay} in an open month.`;
}

export async function salaryInPaidMonthRefusal(companyId: string, from: string, to: string | null = null): Promise<string | null> {
  const paid = await withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    return paidPeriodsOf(tx, companyId, null);
  });
  return salaryPaidMonthText(paid, from, to);
}
