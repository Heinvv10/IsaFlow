import { etiForRemuneration, selectEtiTable } from './etiTables';
import { getAge } from './payeEngine';
import type { EtiInput, EtiMissingInput, EtiResult } from './payrollTypes';

function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

/**
 * The incentive is selected by the pay period (see etiTables), not by
 * `_taxYear`, which is kept so callers do not change.
 *
 * Qualifying age is 18-29 (ETI Act s6(a)). The Special Economic Zone exception
 * (no upper age limit) is NOT applied: nothing in the employee schema records
 * that the employer or employee is in an SEZ, so a SEZ employee aged 30+ is
 * reported ineligible and the claim is forfeited rather than over-claimed.
 */
export function calculateEti(input: EtiInput, _taxYear: number): EtiResult {
  const table = selectEtiTable(input.periodDate);
  const age = getAge(input.dateOfBirth, input.periodDate);
  const monthsEmployed = monthsBetween(input.employmentStartDate, input.periodDate) + 1;

  if (age < 18 || age > 29) {
    return {
      isEligible: false,
      isDeterminable: true,
      missingInputs: [],
      ineligibilityReason: 'Employee age must be 18–29',
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
  if (input.monthlyRemuneration > table.wageCeiling) {
    return {
      isEligible: false,
      isDeterminable: true,
      missingInputs: [],
      ineligibilityReason: `Wage exceeds ETI wage ceiling of R${table.wageCeiling.toLocaleString()}`,
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }
  if (monthsEmployed > 24) {
    return {
      isEligible: false,
      isDeterminable: true,
      missingInputs: [],
      ineligibilityReason: 'ETI window (24 months) expired',
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }

  const employmentYear: 1 | 2 = monthsEmployed <= 12 ? 1 : 2;
  const monthlyEti = etiForRemuneration(input.monthlyRemuneration, employmentYear, table);

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
  taxYear: number,
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

  return calculateEti(
    {
      ...input,
      dateOfBirth: input.dateOfBirth as Date,
      employmentStartDate: input.employmentStartDate as Date,
    },
    taxYear,
  );
}
