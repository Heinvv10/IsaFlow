/**
 * The PAYE tax year: ALWAYS 1 March to the last day of February (SARS), for
 * every company, whatever its financial year end. `companies.financial_year_start`
 * is the books' year and must never anchor payroll: a company with a June year
 * end still files IRP5s and the EMP501 for March-February.
 *
 * A tax year is labelled by the calendar year it ENDS in: 2027 is
 * 2026-03-01 to 2027-02-28. Dates are 'YYYY-MM-DD' strings (no Date
 * round-trip through UTC).
 */

export const PAYE_TAX_YEAR_START_MONTH = 3;
export const PAYE_TAX_YEAR_END_MONTH = 2;
export const PAYE_PERIODS_IN_TAX_YEAR = 12;

/** The label (ending year) of the tax year holding a payroll period (month 1-12). */
export function payeTaxYearOf(periodMonth: number, periodYear: number): number {
  return periodMonth >= PAYE_TAX_YEAR_START_MONTH ? periodYear + 1 : periodYear;
}

/** 1-12: March is period 1, February period 12. */
export function payeTaxPeriodNumber(periodMonth: number): number {
  return ((periodMonth - PAYE_TAX_YEAR_START_MONTH + 12) % 12) + 1;
}

/** 1 March of the year before the label to the last day of February of the label, leap years by date maths. */
export function payeTaxYearBounds(taxYear: number): { start: string; end: string } {
  // Day 0 of March is the last day of February.
  const lastFebruaryDay = new Date(Date.UTC(taxYear, PAYE_TAX_YEAR_START_MONTH - 1, 0)).getUTCDate();
  return {
    start: `${taxYear - 1}-03-01`,
    end: `${taxYear}-02-${String(lastFebruaryDay).padStart(2, '0')}`,
  };
}
