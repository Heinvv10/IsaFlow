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
 *   deemed-standard second limb. The two cannot give different figures: under 22 hours a week and under R394 a day is at most
 *   about R7 470 a month, under the R99 000 annual threshold, so the tables give nil as well. Classified deemed standard.
 *   LOW-MEDIUM confidence: the guide labels that band both ways.
 * "Less than R394" is strict: exactly R394 a day is not under it (p. 28; the table's "more than" rows leave exactly R394 to
 *   the residual definition, 25%).
 */
import type { PayrollEmployee } from './payrollTypes';
import { getTaxYearConfig } from './taxTables';

export const STANDARD_HOURS_PER_WEEK = 22;
export const DEEMED_STANDARD_HOURS_PER_DAY = 5;

export type EmploymentClass = 'standard' | 'deemed_standard' | 'non_standard_flat' | 'undetermined';

export type WorkTerms = Pick<PayrollEmployee, 'taxStatus' | 'payBasis' | 'hoursPerWeek' | 'hoursPerDay' | 'hourlyRate' | 'dailyRate'>;

export interface EmploymentClassification {
  kind: EmploymentClass;
  /** One line for the payslip notes and the validation messages. */
  reason: string;
  /** A monthly employee whose hours are not recorded: standard by default, said out loud (an info result). */
  hoursNotRecorded: boolean;
}

const cents = (n: number): number => Math.round(n * 100);

/** The day's pay: the day rate, else the hourly rate for the day's hours; null when neither gives one. */
function dayPay(t: WorkTerms): number | null {
  if (t.dailyRate != null && t.dailyRate > 0) return t.dailyRate;
  if (t.hourlyRate != null && t.hourlyRate > 0 && t.hoursPerDay != null) return t.hourlyRate * t.hoursPerDay;
  return null;
}

const result = (kind: EmploymentClass, reason: string, hoursNotRecorded = false): EmploymentClassification => ({ kind, reason, hoursNotRecorded });

export function classifyEmployment(terms: WorkTerms, taxYear: number): EmploymentClassification {
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
  const pay = dayPay(terms);
  if (pay != null && threshold != null && cents(pay) >= cents(threshold)) {
    return result('non_standard_flat', `Under ${STANDARD_HOURS_PER_WEEK} hours a week and paid R${threshold} or more a day: non-standard employment (G21 p. 28).`);
  }
  if (hoursPerDay != null && pay != null && threshold != null) {
    return result('deemed_standard', `At least ${DEEMED_STANDARD_HOURS_PER_DAY} hours a day and paid under R${threshold} a day: deemed standard employment (G21 p. 28).`);
  }
  const missing = threshold == null
    ? `the daily threshold for tax year ${taxYear} is not verified`
    : pay == null ? 'the pay for a day (a daily rate, or an hourly rate with hours per day) is not recorded' : 'hours per day are not recorded';
  return result('undetermined', `Works under ${STANDARD_HOURS_PER_WEEK} hours a week, and ${missing}, so G21 p. 28 cannot say whether the employment is standard.`);
}
