import { etiForRemuneration, nationalMinimumWageCents, selectEtiTable } from './etiTables';
import { formatMoney } from '@/lib/money/formatMoney';
import { getAge } from './payeEngine';
import { belowMinimumWage, grossUpTo160, hoursShare } from './etiHours';
import type { EtiInput, EtiMissingInput, EtiResult } from './payrollTypes';

/** ETI Act s6(a) age band, the 24-month window and the first-year length (pinned by taxTableHash.test.ts). */
export const ETI_MIN_AGE = 18;
export const ETI_MAX_AGE = 29;
export const ETI_WINDOW_MONTHS = 24;
export const ETI_FIRST_YEAR_MONTHS = 12;

function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

/**
 * The incentive is selected by the pay period (see etiTables), not by the tax year.
 *
 * Qualifying age is 18-29 (ETI Act s6(a)). The Special Economic Zone exception
 * (no upper age limit) is NOT applied: nothing in the employee schema records
 * that the employer or employee is in an SEZ, so a SEZ employee aged 30+ is
 * reported ineligible and the claim is forfeited rather than over-claimed.
 */
export function calculateEti(input: EtiInput): EtiResult {
  const table = selectEtiTable(input.periodDate);
  // ETI Act s6(a)(i): 18 to 29 "at the end of any month in respect of which the ETI is claimed" (guide Issue 5 §3.2.1
  // p. 24): the age on the month's last day, so the month the employee turns 30 is out, the month they turn 18 is in.
  const monthEnd = new Date(input.periodDate.getFullYear(), input.periodDate.getMonth() + 1, 0);
  const age = getAge(input.dateOfBirth, monthEnd);
  // The 24 months need not be consecutive (guide §3.3 p. 28, §5.1 fn 142): a rehire continues the count (priorMonths).
  const monthsEmployed = monthsBetween(input.employmentStartDate, input.periodDate) + 1 + Math.max(0, input.priorMonths ?? 0);

  if (age < ETI_MIN_AGE || age > ETI_MAX_AGE) {
    return {
      isEligible: false,
      isDeterminable: true,
      missingInputs: [],
      ineligibilityReason: `Employee age must be ${ETI_MIN_AGE}–${ETI_MAX_AGE}`,
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }
  if (input.isUifExcluded) {
    return {
      isEligible: false,
      isDeterminable: true,
      missingInputs: [],
      ineligibilityReason: 'UIF-excluded employees do not qualify',
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }
  // ET: with the hours known, no hours is nil, a wage below the minimum is nil (s4(1)(a)), and under 160 hours the
  // remuneration is grossed up to 160 hours before the table (s7(5); etiHours.ts). Unknown hours: today's figure.
  const hours = input.hours ?? null;
  const determined = (ineligibilityReason: string): EtiResult => ({
    isEligible: false, isDeterminable: true, missingInputs: [], ineligibilityReason, monthsEmployed, employmentYear: null, monthlyEti: 0,
  });
  if (hours && hours.monthlyHours <= 0) return determined('No hours employed and paid in the month (ETI Act s7(5)): nil.');
  const minimum = hours?.ordinaryHours != null ? nationalMinimumWageCents(input.periodDate) : null;
  if (hours?.ordinaryHours != null && minimum != null && belowMinimumWage(hours.ordinaryWageCents, hours.ordinaryHours, minimum)) {
    return determined(`The wage for ${hours.ordinaryHours} ordinary hours (${formatMoney(hours.ordinaryWageCents / 100)}) is below the `
      + `national minimum wage of ${formatMoney(minimum / 100)} an hour (ETI Act s4(1)(a)): nil.`);
  }
  const remuneration = hours ? grossUpTo160(input.monthlyRemuneration, hours.monthlyHours) : input.monthlyRemuneration;
  if (remuneration >= table.wageCeiling) {
    return {
      isEligible: false,
      isDeterminable: true,
      missingInputs: [],
      ineligibilityReason: `Wage is at or above the ETI wage ceiling of ${formatMoney(table.wageCeiling)}`,
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }
  if (monthsEmployed > ETI_WINDOW_MONTHS) {
    return {
      isEligible: false,
      isDeterminable: true,
      missingInputs: [],
      ineligibilityReason: `ETI window (${ETI_WINDOW_MONTHS} months) expired`,
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }

  const employmentYear: 1 | 2 = monthsEmployed <= ETI_FIRST_YEAR_MONTHS ? 1 : 2;
  const monthlyEti = etiForRemuneration(remuneration, employmentYear, table) * (hours ? hoursShare(hours.monthlyHours) : 1);

  return {
    isEligible: true,
    isDeterminable: true,
    missingInputs: [],
    monthsEmployed,
    employmentYear,
    monthlyEti: Math.round(monthlyEti * 100) / 100,
  };
}

/**
 * Resolve ETI for an employee whose date of birth or start date may be absent.
 *
 * `calculateEti` requires both dates; without them age and months-employed are
 * unknowable, so eligibility cannot be assessed at all. Before this existed,
 * payrollCalculator guarded the call and substituted a hardcoded
 * `{ isEligible: false, monthlyEti: 0 }` — a fabricated determination that read
 * as "not eligible" and silently forfeited the credit. Every production run has
 * taken that branch: all 11 payroll_employees rows have a NULL date_of_birth.
 *
 * No ETI is claimed on unknown data and no date is invented. The gap is
 * reported instead, via `isDeterminable` / `missingInputs`, and
 * `validateEti` turns it into a warning on the run.
 */
export function resolveEtiForEmployee(
  input: Omit<EtiInput, 'dateOfBirth' | 'employmentStartDate'> & {
    dateOfBirth?: Date | null;
    employmentStartDate?: Date | null;
  },
): EtiResult {
  const missingInputs: EtiMissingInput[] = [];
  if (!input.dateOfBirth) missingInputs.push('date_of_birth');
  if (!input.employmentStartDate) missingInputs.push('employment_start_date');

  if (missingInputs.length > 0) {
    return {
      isEligible: false,
      // Deliberately NO ineligibilityReason: nothing was determined.
      isDeterminable: false,
      missingInputs,
      monthsEmployed: 0,
      employmentYear: null,
      monthlyEti: 0,
    };
  }

  const result = calculateEti(
    {
      ...input,
      dateOfBirth: input.dateOfBirth as Date,
      employmentStartDate: input.employmentStartDate as Date,
    },
  );
  // ETI Act s6(b) (etiEligibility): ETI that would be claimed needs a document shown. Not shown is not "ineligible" (the
  // employee may hold one): it is not determinable, so nothing is claimed and validateEti warns ETI_INDETERMINATE.
  if (result.monthlyEti > 0 && input.idDocumentShown === false) {
    return { ...result, isEligible: false, isDeterminable: false, missingInputs: ['id_document'], monthlyEti: 0, ineligibilityReason: undefined };
  }
  return result;
}
