/**
 * Weekly and fortnightly periods (wave 6 FQc). Pure; one source for the run's dates, the starter's share of a period,
 * the EMP201 month and whether a run closes its month.
 *
 * Sources:
 *  - Annual equivalent = remuneration x pay periods in the tax year / pay periods worked (Fourth Schedule para 9(1)/(2);
 *    PAYE-GEN-01-G20 (2026) s7.2 pp. 8-9, the same text as G21 (2027) Rev 1 p. 8-10). Its examples count a part period
 *    as a decimal portion of the period: "R1 090 / 0.4285 x 52" for 3 of 7 days (G20 p. 9; G21 p. 10 prints 0.4285,
 *    i.e. 3/7 truncated to four decimals, which is what periodShareOf does). F (52, 26) is annualisationFactor.ts's.
 *  - A 53rd weekly (27th fortnightly) pay day in a tax year, e.g. a Sunday pay day when 1 March and 28 February are both
 *    Sundays. SARS is silent: PAYE-GEN-01-G21 (2027) Rev 1 p. 9, "ANNUAL EQUIVALENT CALCULATION" (Fourth Schedule
 *    para 9(1), 9(2)), gives "Total remuneration received/accrued X Total pay periods in tax year / Total pay periods
 *    worked" and says nothing of an extra pay day; PAYE-GEN-01-G01 (tax deduction tables) is silent too. The PAYE BRS
 *    (Employer Reconciliation V25.3.0, p. 33) defines 3200 as the pay periods the employer divides the year into and
 *    3210 as the periods worked, "Cannot be greater than the value for pay periods in year of assessment", so a
 *    53-payday year certifies 3200 = 53 (ruling 14, wave 7 CW), but that rule is about the certificate, not the tax.
 *    Ruling 9 (Hein 2026-11-25): with SARS silent, keep x 52 per week (F = 52 over n = 53, so the year's tax is
 *    tax(AE) x 53 / 52: SimplePay's documented YTD x 52 / periods worked; wave-6 ruling 16) and warn on the line
 *    (extraPayDayWarnings, WEEK_53_PAY_DAY). G21 p. 6: an employer may adopt an alternate tax period, which avoids it.
 *    Still UNVERIFIED (unverified.json): no SARS page decides x 52 against x 53.
 *  - The EMP201 month is the month the pay is paid in: employees' tax is paid "within seven days after the end of the
 *    month during which the amount was deducted" (Fourth Schedule para 2(1)), so a week straddling two months belongs
 *    to its pay date's month (payDateOf: run_date, else period_end; payrollRunOrder's key 2).
 * Monthly is unchanged: share 1, every run closes its month.
 */
import type { ValidationResult } from './payrollTypes';
import type { PayFrequency, PayrollPeriod } from './payrollTypesRun';

/** Days in a weekly and a fortnightly period. */
export const PERIOD_DAYS: Readonly<Record<Exclude<PayFrequency, 'monthly'>, number>> = { weekly: 7, fortnightly: 14 };

const DAY_MS = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A 'YYYY-MM-DD' as a UTC day number (no time zone can move it). */
export function dayNumber(iso: string): number {
  const m = ISO.exec(iso);
  if (!m) throw new Error(`payFrequencyPeriods: not a date: ${iso}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

export function isoOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** A Date (an employee's start or end, read at local midnight or UTC midnight) as its calendar day. */
export function isoOfDate(d: Date): string {
  const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  const p = (n: number) => String(n).padStart(2, '0');
  return utcMidnight
    ? d.toISOString().slice(0, 10)
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The share of a weekly or fortnightly period the employee was employed in (calendar days, start and end inclusive),
 * truncated to four decimals as G21 p. 10 prints it (3 of 7 days = 0.4285). Monthly: 1 (a monthly starter's period
 * counts whole, as it always has). Not employed in the period at all: 0.
 */
export function periodShareOf(
  frequency: PayFrequency, period: Pick<PayrollPeriod, 'start' | 'end'>, startDate: Date, endDate?: Date | null,
): number {
  if (frequency === 'monthly' || !period.start || !period.end) return 1;
  const from = dayNumber(period.start);
  const to = dayNumber(period.end);
  const employedFrom = Math.max(from, dayNumber(isoOfDate(startDate)));
  const employedTo = Math.min(to, endDate ? dayNumber(isoOfDate(endDate)) : to);
  const days = Math.max(0, employedTo - employedFrom + 1);
  return Math.floor((days / (to - from + 1)) * 10_000) / 10_000;
}

/** The pay date: the run's own, else its period's last day (payrollRunOrder's key 2). */
export function payDateOf(period: Pick<PayrollPeriod, 'end'>, runDate: string | null): string | null {
  return runDate ?? period.end ?? null;
}

/** The EMP201 month of a pay date (Fourth Schedule para 2(1)). */
export function emp201MonthOf(payDate: string): { year: number; month: number } {
  return { year: Number(payDate.slice(0, 4)), month: Number(payDate.slice(5, 7)) };
}

/**
 * True when no later regular run of this frequency is paid in the same month: the next pay date (this one plus a
 * period) falls in a later month. Monthly runs always close their month. ETI is claimed on that run for the month
 * (payrollLineEtiMonth).
 */
export function closesPayMonth(frequency: PayFrequency, payDate: string): boolean {
  if (frequency === 'monthly') return true;
  return isoOfDay(dayNumber(payDate) + PERIOD_DAYS[frequency]).slice(0, 7) !== payDate.slice(0, 7);
}

/** The line code for a pay day past the tax year's statutory periods (W1; spec §0b). Non-blocking. */
export const EXTRA_PAY_DAY = 'WEEK_53_PAY_DAY';

/**
 * WEEK_53_PAY_DAY when this line takes the periods worked past the year's statutory periods (n > P: the 53rd weekly or
 * 27th fortnightly pay day; a starter's part week counts its share, so 52 + a part is a 53rd pay day too). PAYE stays
 * x 52 / x 26 (ruling 9; G21 (2027) Rev 1 p. 9 is silent on it, see the header). Monthly never: P = 12 is the calendar.
 * Compared at four decimals, the precision a share is kept at (periodShareOf), so float noise in a sum of shares
 * (52.00000000000001) is no 53rd pay day (review #1928). Not raised when:
 *  - the line's PAYE is not from the tables (contractor, PSP, flat 25%, a directive): nothing was annualised;
 *  - the year's earlier tables lines include another pay frequency: n then adds periods of two lengths, so n > P does
 *    not mean an extra pay day (review #1928 breaker). The divisor itself is FQe's (engine 23, Hein ruling 23).
 */
export function extraPayDayWarnings(line: {
  frequency: PayFrequency; periodsWorked: number; periodsInYear: number; onTables: boolean;
  /** The pay frequencies of the year's earlier tables lines (PayeYearToDate.frequencies); absent = none. */
  frequenciesToDate?: readonly PayFrequency[];
}): ValidationResult[] {
  const { frequency, periodsWorked, periodsInYear } = line;
  const at4dp = (n: number) => Math.round(n * 10_000);
  if (frequency === 'monthly' || !line.onTables || at4dp(periodsWorked) <= at4dp(periodsInYear)) return [];
  if ((line.frequenciesToDate ?? []).some((f) => f !== frequency)) return [];
  const unit = frequency === 'weekly' ? 'week' : 'fortnight';
  return [{
    code: EXTRA_PAY_DAY, severity: 'warning',
    message: `${periodsInYear + 1}${periodsInYear + 1 === 53 ? 'rd' : 'th'} ${frequency} pay day of the tax year. SARS's guide (PAYE-GEN-01-G21 (2027) Rev 1 p. 9) `
      + `does not say how to annualise it; IsaFlow keeps x ${periodsInYear} per ${unit}. An alternate tax period (G21 p. 6) avoids it.`,
  }];
}
