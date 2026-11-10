/**
 * Which kind of employment an employee is in, from the terms of work (PAYE-GEN-01-G21 (2027) Rev 1 p. 27-28; G20 (2026)
 * p. 27-28 is the same text with R383 for R394). Never from a label: the guide decides it from hours and day pay. Pure.
 *
 * Standard: required to work at least 22 hours in a week (p. 27-28 "Standard employment"). Tables.
 * Deemed standard: under 22 hours, but at least 5 hours a day and paid under the daily threshold (p. 28 "Deemed Standard
 *   Employment", second limb). Tables. The first limb (under 22 hours with a written declaration of no other employer) needs
 *   the declaration, which IsaFlow does not record: it is a named limit, said in the warning on every flat-rate line
 *   (taxStatusTreatment.outsideTablesResult).
 * Non-standard: anything else (p. 28 "Non-standard employment: any employment which cannot be classified under Standard or
 *   Deemed Standard"). 25% of the balance of remuneration (p. 28 "Employees' tax"). That covers the summary table's rows 4
 *   (at least 5 hours a day, more than the threshold) and 5 (under 5 hours a day, under the threshold), and the case the
 *   table does not print, under 5 hours a day and at or over the threshold, which the residual definition catches.
 * The summary table's row 3 (non-standard, at least 5 hours a day, under the threshold: no tax) is the same band as the
 *   deemed-standard second limb, so it is classified deemed standard (tables). The two differ only where the tables tax
 *   something row 3 would not: under 22 hours a week and under R394 a day the rate-based pay is at most about R7 470 a month
 *   (R89 600 a year, under the R99 000 threshold), so the tables give nil as well, UNLESS earnings outside the rate lift the
 *   year over the threshold (a bonus, overtime): then the tables tax it and row 3 would not. LOW-MEDIUM confidence: the
 *   guide labels that band both ways.
 * Day pay is "remuneration per day" (p. 28: "earns ... for that day"), so it follows what the line pays, but earnings may only
 *   RAISE it. With a recorded rate the day pay is max(recorded rate, earned): a short month (a starter, unpaid leave, fewer
 *   hours than scheduled) lowers the earned figure and must never lower the withholding. Earned = the periodic earnings for
 *   time worked (timeWorkedEarnings: recurring 3601 basic pay, 3607 overtime, not once-off 3601 back pay; not commission, allowances or non-cash benefits, which are
 *   not pay for a day's work; LOW-MEDIUM confidence, G21 p. 28 says only "earns ... for that day") over the scheduled days
 *   (hours a week / hours a day, x 52 / 12 a month) scaled by the share of the month the employee was employed. With no
 *   recorded rate the earned figure stands in. DAY_PAY_TOLERANCE only governs the warning, never the class. The share of the
 *   month is in WORKING days (Monday to Friday); public holidays are NOT excluded (no holiday calendar exists in the repo and none is
 *   hardcoded here: a named limit, which can only make a short month's earned day pay lower, and earnings only raise the day pay).
 * "Less than R394" is strict: exactly R394 a day is not under it (p. 28; the table's "more than" rows leave exactly R394 to
 *   the residual definition, 25%).
 */
import type { PayrollEmployee } from './payrollTypes';
import { getTaxYearConfig } from './taxTables';
import { formatMoney } from '@/lib/money/formatMoney';
import { normaliseSarsCode } from './payeAnnualPayment';

export const STANDARD_HOURS_PER_WEEK = 22;
export const DEEMED_STANDARD_HOURS_PER_DAY = 5;

export type EmploymentClass = 'standard' | 'deemed_standard' | 'non_standard_flat' | 'undetermined';

export type WorkTerms = Pick<PayrollEmployee, 'taxStatus' | 'payBasis' | 'hoursPerWeek' | 'hoursPerDay' | 'hourlyRate' | 'dailyRate'>;

export interface EmploymentClassification {
  kind: EmploymentClass;
  /** One line for the payslip notes and the validation messages. */
  reason: string;
  /** A monthly employee whose hours are not recorded: standard by default, said out loud. */
  hoursNotRecorded: boolean;
  /** Set when the day pay the line earns differs from the recorded rate and decided the class (a warning on the line). */
  dayPayNote?: string;
  /** The class was decided from the line's earnings alone: no daily or hourly rate is recorded (a warning on the line). */
  rateNotRecorded?: boolean;
}

/** The relative gap between the earnings-derived day pay and the recorded rate that counts as a disagreement (rounding of days a month sits near 2%). */
export const DAY_PAY_TOLERANCE = 0.03;
const WEEKS_PER_MONTH = 52 / 12;

const cents = (n: number): number => Math.round(n * 100);

/** The day's pay: the day rate, else the hourly rate for the day's hours; null when neither gives one. */
function dayPay(t: WorkTerms): number | null {
  if (t.dailyRate != null && t.dailyRate > 0) return t.dailyRate;
  if (t.hourlyRate != null && t.hourlyRate > 0 && t.hoursPerDay != null) return t.hourlyRate * t.hoursPerDay;
  return null;
}

const result = (kind: EmploymentClass, reason: string, hoursNotRecorded = false, dayPayNote?: string, rateNotRecorded = false): EmploymentClassification => ({
  kind, reason, hoursNotRecorded, ...(dayPayNote ? { dayPayNote } : {}), ...(rateNotRecorded ? { rateNotRecorded } : {}),
});

/**
 * The line's earnings that are pay for time worked: recurring basic pay (3601) and overtime (3607), whatever their assignment. A
 * once-off 3601 is out, back pay and corrections for other periods and also a once-off priced as quantity x the recorded rate (what
 * HD adds): that rate already is the day pay, so counting the row would over-withhold (R300 a day for 25 days is not a R750 day).
 */
export function timeWorkedEarnings(components: ReadonlyArray<{ component: { componentType: string; sarsSourceCode: string }; amount: number; isRecurring?: boolean }>): number {
  return components.reduce((t, c) => {
    if (c.component.componentType !== 'earning') return t;
    const code = normaliseSarsCode(c.component.sarsSourceCode);
    const counts = code === '3607' || (code === '3601' && c.isRecurring !== false);
    return counts ? t + c.amount : t;
  }, 0);
}

/** What the earnings for time worked pay for a scheduled day: earnings / (hours a week / hours a day x 52 / 12 x share of the month employed); null when the schedule is not known. */
function earnedDayPay(terms: WorkTerms, input: DayPayInput, share: number): number | null {
  const { earnings } = input;
  if (earnings == null || earnings <= 0 || terms.hoursPerWeek == null || terms.hoursPerDay == null || terms.hoursPerDay <= 0) return null;
  return earnings / ((terms.hoursPerWeek / terms.hoursPerDay) * WEEKS_PER_MONTH * Math.min(1, Math.max(0.01, share)));
}

/** The day pay that decides (earnings may only raise a recorded rate), and the note when they did by more than the tolerance. */
function decidingDayPay(terms: WorkTerms, input: DayPayInput): { pay: number | null; note?: string; rateNotRecorded?: boolean } {
  const recorded = dayPay(terms);
  // Not employed in the period (a leaver paid after leaving, a start after it): the earnings are not for days worked in it, so a
  // recorded rate decides alone; with none, the earnings stand in over the full month's schedule, as for any line with no rate.
  const notEmployed = input.employedShare != null && input.employedShare <= 0;
  if (notEmployed && recorded != null) return { pay: recorded };
  const earned = earnedDayPay(terms, input, notEmployed ? 1 : input.employedShare ?? 1);
  if (earned == null) return { pay: recorded };
  if (recorded == null) return { pay: earned, rateNotRecorded: true };
  const pay = Math.max(recorded, earned);
  if (earned <= recorded * (1 + DAY_PAY_TOLERANCE)) return { pay };
  return {
    pay,
    note: `The recorded day pay is ${formatMoney(recorded)}, but this line's basic pay and overtime pay ${formatMoney(Math.round(earned * 100) / 100)} for a scheduled day `
      + `(${terms.hoursPerWeek} hours a week in days of ${terms.hoursPerDay}). Earnings can only raise the day pay, never lower it, so the higher figure decides the employment class `
      + '(G21 p. 28, "earns ... for that day"). If the rate or the hours are wrong, correct them.',
  };
}

/**
 * The share of the period's WORKING days (Monday to Friday, public holidays not excluded: see the file header) the employee was employed,
 * start and end dates inclusive; 0 only when they were not employed in the month at all (a start after it, an end before it). A start on
 * the month's last weekend (or an end on its first) is employed but on no working day: that counts as one working day, never as 0.
 */
export function employedShareOfMonth(period: { year: number; month: number }, startDate: Date, endDate?: Date): number {
  const days = new Date(period.year, period.month, 0).getDate();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  let all = 0;
  let employed = 0;
  let employedCalendar = 0;
  for (let d = 1; d <= days; d += 1) {
    const date = new Date(period.year, period.month - 1, d);
    const isEmployed = date.getTime() >= day(startDate) && (endDate == null || date.getTime() <= day(endDate));
    if (isEmployed) employedCalendar += 1;
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    all += 1;
    if (isEmployed) employed += 1;
  }
  if (all === 0) return 1;
  return employed === 0 && employedCalendar > 0 ? 1 / all : employed / all;
}

/** What the line pays for time worked, and how much of the month the employee was employed: the day pay's evidence. */
export interface DayPayInput { earnings?: number; employedShare?: number }

export function classifyEmployment(terms: WorkTerms, taxYear: number, dayPayInput: DayPayInput = {}): EmploymentClassification {
  // A director is an employee on the tables (G21 p. 27) and a contractor is outside PAYE altogether: neither is classified by hours.
  if (terms.taxStatus !== 'employee') return result('standard', 'Not classified by hours (tax status).');
  const { hoursPerWeek, hoursPerDay } = terms;
  if (hoursPerWeek == null) {
    return terms.payBasis === 'monthly'
      ? result('standard', 'Hours not recorded; classified as standard employment', true)
      : result('undetermined', `Weekly hours are not recorded for this ${terms.payBasis} employee, so G21 p. 28 cannot say whether the employment is standard.`);
  }
  if (hoursPerWeek >= STANDARD_HOURS_PER_WEEK) {
    return result('standard', `Required to work ${hoursPerWeek} hours a week, at least ${STANDARD_HOURS_PER_WEEK} (G21 p. 27-28).`);
  }
  const threshold = getTaxYearConfig(taxYear).nonStandardDailyThreshold;
  // A year with no verified daily threshold never classifies daily-rated staff: it would be a guess (blocking, not silent).
  if (threshold == null && (terms.payBasis === 'daily' || terms.dailyRate != null)) {
    return result('undetermined', `Daily-rated employee under ${STANDARD_HOURS_PER_WEEK} hours a week, and the daily threshold for tax year ${taxYear} is not verified, so G21 p. 28 cannot say whether the employment is standard.`);
  }
  if (hoursPerDay != null && hoursPerDay < DEEMED_STANDARD_HOURS_PER_DAY) {
    return result('non_standard_flat', `Under ${STANDARD_HOURS_PER_WEEK} hours a week and under ${DEEMED_STANDARD_HOURS_PER_DAY} hours a day: non-standard employment (G21 p. 28).`);
  }
  const { pay, note, rateNotRecorded } = decidingDayPay(terms, dayPayInput);
  if (pay != null && threshold != null && cents(pay) >= cents(threshold)) {
    return result('non_standard_flat', `Under ${STANDARD_HOURS_PER_WEEK} hours a week and paid ${formatMoney(threshold)} or more a day: non-standard employment (G21 p. 28).`, false, note, rateNotRecorded);
  }
  if (hoursPerDay != null && pay != null && threshold != null) {
    return result('deemed_standard', `At least ${DEEMED_STANDARD_HOURS_PER_DAY} hours a day and paid under ${formatMoney(threshold)} a day: deemed standard employment (G21 p. 28).`, false, note, rateNotRecorded);
  }
  const missing = threshold == null
    ? `the daily threshold for tax year ${taxYear} is not verified`
    : pay == null ? 'the pay for a day (a daily rate, or an hourly rate with hours per day) is not recorded' : 'hours per day are not recorded';
  return result('undetermined', `Works under ${STANDARD_HOURS_PER_WEEK} hours a week, and ${missing}, so G21 p. 28 cannot say whether the employment is standard.`);
}
