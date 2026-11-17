/**
 * ETI for weekly and fortnightly pay (wave 6 FQc). ETI is a monthly incentive on "monthly remuneration": "it is only
 * an amount of remuneration that is 'paid or is payable' to an employee in the particular month that will constitute
 * ... 'monthly remuneration', in that month ... an eligible employer is only entitled to claim the ETI in the month in
 * which the relevant remuneration ... is 'paid or payable'" (SARS Guide to the Employment Tax Incentive, Issue 5,
 * 27 July 2026, s2.4 p. 15), and the month's remuneration includes amounts paid "on a monthly, weekly, daily or hourly
 * basis" (s2.4.1 p. 18). So a weekly or fortnightly line claims nothing on its own: it records its parts
 * (ETI_MONTH_PENDING), and the month's last regular run of that frequency (by pay date; payFrequencyPeriods
 * .closesPayMonth) claims the month on the month's remuneration and hours, its own plus those parts.
 *
 * NOT FOLLOWED: Binding General Ruling (ETI) 47 Issue 2 (19 April 2023) lets an employer paying weekly or fortnightly
 * align the ETI "month" with its PAYE periods, applied consistently. IsaFlow uses the calendar month (the ruling's
 * default), so no election is needed.
 * NAMED LIMITS: the parts are read from the month's FINAL runs (a run not yet approved when the closing run is
 * calculated is not in it; the year-to-date gate refuses that approval order); a run reopened after the month closed
 * moves the month's figure only when the closing run is recalculated.
 */
import { etiRemunerationOf, ordinaryWageCents, overtimeHours } from './etiHours';
import { unitOf } from './payrollRunHours';
import { PERIOD_DAYS } from './payFrequencyPeriods';
import type { EmployeeComponent, EtiMonthParts, EtiResult, LineCadence, PayrollEmployee, ValidationResult } from './payrollTypes';

export const ETI_MONTH_PENDING = 'ETI_MONTH_PENDING';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** This line's ETI parts, which the month's closing run adds up. */
export function etiMonthPartsOf(
  employee: PayrollEmployee, cadence: LineCadence, runHours: number | null, components: EmployeeComponent[],
): EtiMonthParts {
  const wageCents = ordinaryWageCents(components);
  const byTime = unitOf(employee) != null;
  const days = cadence.frequency === 'monthly' ? 0 : PERIOD_DAYS[cadence.frequency];
  // The period's ordinary hours: the run's own (hourly or daily), else the contracted hours a week for its weeks.
  const ordinary = byTime ? runHours : employee.hoursPerWeek == null ? null : Number(employee.hoursPerWeek) * (days / 7);
  const rate = ordinary != null && ordinary > 0 ? wageCents / 100 / ordinary : 0;
  return {
    remuneration: round2(etiRemunerationOf(components)),
    wageCents,
    ordinaryHours: byTime ? runHours : null,
    overtimeHours: round2(overtimeHours(components, rate)),
  };
}

/** Parts summed (any unknown ordinary hours make the month's unknown). */
export function addEtiMonthParts(a: EtiMonthParts, b: EtiMonthParts): EtiMonthParts {
  return {
    remuneration: round2(a.remuneration + b.remuneration),
    wageCents: a.wageCents + b.wageCents,
    ordinaryHours: a.ordinaryHours == null || b.ordinaryHours == null ? null : round2(a.ordinaryHours + b.ordinaryHours),
    overtimeHours: round2(a.overtimeHours + b.overtimeHours),
  };
}

export const NO_ETI_PARTS: EtiMonthParts = { remuneration: 0, wageCents: 0, ordinaryHours: 0, overtimeHours: 0 };

/** The pending line's ETI (nil) and its result, carrying the parts. */
export function pendingEti(resolved: EtiResult, parts: EtiMonthParts): { eti: EtiResult; warnings: ValidationResult[] } {
  return {
    eti: {
      ...resolved, monthlyEti: 0,
      ineligibilityReason: 'ETI is monthly: it is claimed on the last run of the month paid at this frequency.',
    },
    warnings: [{
      code: ETI_MONTH_PENDING, severity: 'info', etiMonth: parts,
      message: 'ETI is claimed for the whole month on the month\'s last weekly or fortnightly run, on all the month\'s pay '
        + '(SARS ETI guide Issue 5 s2.4 p. 15): this run records its pay and hours for it and claims none itself.',
    }],
  };
}
