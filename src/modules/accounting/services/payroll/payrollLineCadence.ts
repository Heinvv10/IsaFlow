/**
 * What a line's pay frequency changes in its costing (wave 6 FQc), in one place so the calculator stays the PAYE /
 * UIF / SDL story. A line without a cadence is monthly and gets exactly the monthly terms it always had.
 *  - PAYE: F by frequency (annualisationFactor: monthly 365 / 30.4166, fortnightly 26, weekly 52) and the share of the
 *    period worked in n (payFrequencyPeriods.periodShareOf).
 *  - UIF: the room left under the month's ceiling after the month's earlier runs (uifEngine; UIC Act s6(1)(a)).
 *  - ETI: pending until the month's last run of the frequency (payrollLineEtiMonth).
 *  - The employment class (G21 p. 28 day pay, employmentTerms): the period's time-worked earnings as a month's, so a
 *    week's pay is not read as a month's (which would understate the day pay 4.33 times).
 * SDL needs nothing here: it is cumulative over the tax year's lines whatever their length (sdlLeviableCumulative).
 */
import { annualisationFactor, periodsInYear } from './annualisationFactor';
import { employedShareOfMonth } from './employmentTerms';
import { PERIOD_DAYS, periodShareOf } from './payFrequencyPeriods';
import type { PayFrequency, PayrollLineInput } from './payrollTypes';

export interface CadenceTerms {
  frequency: PayFrequency;
  factor: number;
  /** P, the statutory periods in a year (12, 26, 52): AN's period ratios, min(n, P) ÷ P. */
  periodsInYear: number;
  periodShare: number;
  uifMonthToDate: number;
  /** The earnings and share of the period employed, as employmentTerms reads a month. */
  dayPay: (timeWorked: number) => { earnings: number; employedShare: number };
}

const WEEKS_PER_MONTH = 52 / 12;

export function cadenceTermsOf(input: PayrollLineInput): CadenceTerms {
  const { employee, period, cadence } = input;
  const frequency = cadence?.frequency ?? 'monthly';
  if (frequency === 'monthly' || !cadence) {
    return {
      frequency: 'monthly', factor: annualisationFactor('monthly'), periodsInYear: periodsInYear('monthly'), periodShare: 1, uifMonthToDate: 0,
      dayPay: (earnings) => ({ earnings, employedShare: employedShareOfMonth(period, employee.startDate, employee.endDate) }),
    };
  }
  const periodShare = periodShareOf(frequency, { start: cadence.periodStart, end: cadence.periodEnd }, employee.startDate, employee.endDate);
  const weeks = PERIOD_DAYS[frequency] / 7;
  return {
    frequency, factor: annualisationFactor(frequency), periodsInYear: periodsInYear(frequency), periodShare,
    uifMonthToDate: cadence.uifMonthToDate,
    dayPay: (earnings) => ({ earnings: (earnings * WEEKS_PER_MONTH) / weeks, employedShare: periodShare }),
  };
}
