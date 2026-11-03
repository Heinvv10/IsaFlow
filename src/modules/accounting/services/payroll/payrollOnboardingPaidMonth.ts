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
 * The refusal for an open-ended salary starting `from`, or null when no paid month falls on or after it. Names every
 * month from the start through the latest paid month the hire would miss: the paid ones, and the open ones between
 * (a salary cannot start in an open month that a later paid month runs through). The salary moves to the month after.
 */
export function salaryPaidMonthText(paid: Period[], from: string): string | null {
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  const paidIdx = new Set(paid.map(indexOf));
  const latest = Math.max(-1, ...paidIdx);
  if (latest < start) return null;
  const all = Array.from({ length: latest - start + 1 }, (_, k) => start + k);
  const gaps = all.filter((i) => !paidIdx.has(i));
  const paidHere = all.filter((i) => paidIdx.has(i));
  const next = periodOf(latest + 1);
  const names = all.map((i) => MONTHS[periodOf(i).month - 1]!);
  const first = paidHere.length === 1 ? `${monthsText(paidHere)} is` : `${monthsText(paidHere)} are`;
  const because = gaps.length ? `, so ${monthsText(gaps)} cannot start the salary either` : '';
  const pay = all.length === 1 ? `the ${names[0]} days as a once-off` : gaps.length ? `the ${joined(names)} days as once-offs` : 'those days as once-offs';
  return `${first} already paid${because}. Set the salary to start ${next.year}-${String(next.month).padStart(2, '0')}-01 and pay ${pay} in an open month.`;
}

export async function salaryInPaidMonthRefusal(companyId: string, from: string): Promise<string | null> {
  const paid = await withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    return paidPeriodsOf(tx, companyId, null);
  });
  return salaryPaidMonthText(paid, from);
}
