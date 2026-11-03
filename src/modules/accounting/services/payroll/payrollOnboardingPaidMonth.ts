/**
 * Onboarding a hire with a salary whose open-ended window would run through a month the company's paid runs already
 * paid: that run never paid it and never will. Judged BEFORE the employee is written (a 4xx commits, so nothing may
 * be written first), under the company's payroll-approval lock, which the request transaction then holds while the
 * employee and the salary are written. Returns the refusal text, or null when the salary may start on `from`.
 */
import { withTransaction } from '@/lib/neon';
import { lockCompanyPayrollForComponentChange, paidPeriodsOf } from './payrollComponentPaidMonths';
import { payrollRunReadDate } from './payrollRunReadDate';

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
export function salaryPaidMonthText(
  paid: Period[], from: string, to: string | null = null, endsWithEmployment = true, endDay: string | null = null,
): string | null {
  const start = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1;
  const end = to === null ? Infinity : Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)) - 1;
  const paidIdx = new Set(paid.map(indexOf));
  const latest = Math.max(-1, ...[...paidIdx].filter((i) => i <= end));
  if (latest < start) return null;
  const next = periodOf(latest + 1);
  const nextFirst = `${next.year}-${String(next.month).padStart(2, '0')}-01`;

  /** The months from the start through `through` as the sentence parts: which are paid, which cannot start a salary, what to pay as once-offs. */
  const describe = (through: number) => {
    const all = Array.from({ length: through - start + 1 }, (_, k) => start + k);
    const gaps = all.filter((i) => !paidIdx.has(i));
    const paidHere = all.filter((i) => paidIdx.has(i));
    const sameYear = all.every((i) => periodOf(i).year === periodOf(all[0]!).year);
    const names = sameYear ? joined(all.map((i) => MONTHS[periodOf(i).month - 1]!)) : joined(all.map((i) => monthsText([i])));
    return {
      first: paidHere.length === 1 ? `${monthsText(paidHere)} is` : `${monthsText(paidHere)} are`,
      because: gaps.length ? `, so ${monthsText(gaps)} cannot start the salary either` : '',
      pay: all.length === 1 ? `the ${names} days as a once-off` : gaps.length ? `the ${names} days as once-offs` : 'those days as once-offs',
    };
  };
  const noRoom = (through: number) => {
    const d = describe(through);
    return `${d.first} already paid${d.because}. The end date ${to} leaves no open month for the salary: pay ${d.pay} in an open month and create the employee without a salary.`;
  };

  const d = describe(latest);
  const startAdvice = `Set the salary to start ${nextFirst} and pay ${d.pay} in an open month.`;
  if (to !== null && end >= latest + 1 && !paysItsLastMonth(to, endsWithEmployment)) {
    // The salary would run on into a month it is not paid in. Give the end advice with the start advice, so following
    // the one message is enough (otherwise the next try meets the early-end refusal) ...
    const endAdvice = adviseEnd(nextFirst, to, endsWithEmployment, endDay);
    if (!endAdvice.withoutSalary) return `${d.first} already paid${d.because}. ${startAdvice} Its end needs changing too: ${endAdvice.text}`;
    // ... or, when the employment ends in that very month before the 27th, no salary can be paid there at all.
    return noRoom(end);
  }
  // The salary ends inside the paid months: nothing left to start.
  if (to !== null && nextFirst > to) return noRoom(latest);
  return `${d.first} already paid${d.because}. ${startAdvice}`;
}

/**
 * Whether a recurring row closed on `to` is read in its last month. A run reads components on the month's last day. A row
 * reaching the 27th is read for the whole month only when it ends WITH the employment (pec.effective_to = the
 * employee's end_date, payrollComponentService); any other row must reach the month's last day, or it is not read and
 * its run is blocked for a manual pro-rata. `endsWithEmployment` is whether the salary ends on the employee's end date.
 */
function paysItsLastMonth(to: string, endsWithEmployment: boolean): boolean {
  const day = Number(to.slice(8, 10));
  return endsWithEmployment ? day >= 27 : to === payrollRunReadDate({ year: Number(to.slice(0, 4)), month: Number(to.slice(5, 7)) });
}

/** The advice for a salary closed where it pays nothing for its last month; `withoutSalary` when no end date can help. */
function adviseEnd(from: string, to: string, endsWithEmployment: boolean, endDay: string | null): { text: string; withoutSalary: boolean } {
  const month = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7)) - 1;
  const prevEnd = payrollRunReadDate(periodOf(month - 1));
  const ownEnd = payrollRunReadDate(periodOf(month));
  const name = MONTHS[periodOf(month).month - 1]!;
  const label = `${name} ${periodOf(month).year}`;
  const days = `pay the ${name} days as a once-off in an open month`;
  if (!endsWithEmployment) {
    const why = `A salary that ends before the employment does must end on the last day of a month: a run reads pay components on that day, so a salary ending on ${to} `
      + `is not paid for ${label} and blocks its run.`;
    // The employment ends inside this month: the month end is out of reach, and the salary ends with the employment
    // (from the 27th, when it is read) or earlier on the previous month end.
    if (endDay !== null && endDay.slice(0, 7) === to.slice(0, 7)) {
      if (Number(endDay.slice(8, 10)) >= 27) return { text: `${why} End the salary with the employment on ${endDay} (or omit salary.effectiveTo).`, withoutSalary: false };
      return prevEnd >= from
        ? { text: `${why} End the salary on ${prevEnd} and ${days}.`, withoutSalary: false }
        : { text: `${why} Create the employee without a salary and ${days}.`, withoutSalary: true };
    }
    return prevEnd >= from
      ? { text: `${why} End the salary on ${prevEnd} and ${days}, or on ${ownEnd} to pay all of ${name}.`, withoutSalary: false }
      : { text: `${why} End the salary on ${ownEnd} to pay all of ${name}.`, withoutSalary: false };
  }
  const why = `A salary ending on ${to} is paid nothing for ${label} (a run reads pay components on the last day of the month, so a salary that `
    + 'ends before the 27th is not paid that month).';
  return prevEnd >= from
    ? { text: `${why} End the salary on ${prevEnd} and ${days}.`, withoutSalary: false }
    : { text: `${why} Create the employee without a salary and ${days}.`, withoutSalary: true };
}

/** A salary closed where it pays nothing for its last month, with no flag: refused, with a followable way out. */
export function salaryEndRefusal(
  from: string, to: string | null, endsWithEmployment = true, endDay: string | null = null,
): string | null {
  if (to === null || paysItsLastMonth(to, endsWithEmployment)) return null;
  return adviseEnd(from, to, endsWithEmployment, endDay).text;
}

export async function salaryInPaidMonthRefusal(
  companyId: string, from: string, to: string | null = null, endsWithEmployment = true, endDay: string | null = null,
): Promise<string | null> {
  const paid = await withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    return paidPeriodsOf(tx, companyId, null);
  });
  return salaryPaidMonthText(paid, from, to, endsWithEmployment, endDay);
}
