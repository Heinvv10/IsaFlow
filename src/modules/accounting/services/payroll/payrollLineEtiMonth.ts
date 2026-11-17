/**
 * ETI for weekly and fortnightly pay (wave 6 FQc). ETI is a monthly incentive on "monthly remuneration" (ETI Act s7):
 * "The age and monthly remuneration of the qualifying employee must be determined at the end of each month" (SARS
 * PAYE-GEN-01-G05, Guide for Employers in respect of ETI, Revision 17, 19 September 2025, s9 p. 6), and code 7002 is the
 * "Actual remuneration (as defined in the ETI Act) paid to the employee for a specified month" (same guide, s19 p. 12).
 * So a weekly or fortnightly line claims nothing on its own: it records its parts (ETI_MONTH_PENDING), and the month's
 * last regular run of that frequency (by pay date; payFrequencyPeriods.closesPayMonth) claims the month on the month's
 * remuneration and hours, its own plus those parts.
 * UNVERIFIED by FQc (not read against the document): the Guide to the ETI Issue 5 s2.4 pp. 15-18 wording that weekly
 * and fortnightly pay counts in the month it is paid or payable, and whether a SARS ruling lets an employer align the ETI
 * "month" with its pay weeks. IsaFlow uses the calendar month of the pay date either way, so no election is read.
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
        + '(SARS PAYE-GEN-01-G05 Rev 17 s9: monthly remuneration is determined at the end of each month): this run records '
        + 'its pay and hours for it and claims none itself.',
    }],
  };
}
