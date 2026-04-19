import { getTaxYearConfig } from './taxTables';
import { getAge } from './payeEngine';
import type { EtiInput, EtiResult } from './payrollTypes';

function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

export function calculateEti(input: EtiInput, taxYear: number): EtiResult {
  const config = getTaxYearConfig(taxYear);
  const age = getAge(input.dateOfBirth, input.periodDate);
  const monthsEmployed = monthsBetween(input.employmentStartDate, input.periodDate) + 1;

  if (age < 18 || age > 35) {
    return {
      isEligible: false,
      ineligibilityReason: 'Employee age must be 18–35',
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }
  if (input.isUifExcluded) {
    return {
      isEligible: false,
      ineligibilityReason: 'UIF-excluded employees do not qualify',
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }
  if (input.monthlyRemuneration > config.etiWageCeiling) {
    return {
      isEligible: false,
      ineligibilityReason: `Wage exceeds ETI wage ceiling of R${config.etiWageCeiling.toLocaleString()}`,
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }
  if (monthsEmployed > 24) {
    return {
      isEligible: false,
      ineligibilityReason: 'ETI window (24 months) expired',
      monthsEmployed,
      employmentYear: null,
      monthlyEti: 0,
    };
  }

  const employmentYear: 1 | 2 = monthsEmployed <= 12 ? 1 : 2;
  const maxEti = employmentYear === 1 ? config.etiYearOneMax : config.etiYearTwoMax;

  let monthlyEti: number;
  if (input.monthlyRemuneration <= config.etiWageFloor) {
    monthlyEti = 0;
  } else if (input.monthlyRemuneration <= 4_500) {
    monthlyEti = maxEti;
  } else {
    const taper =
      (config.etiWageCeiling - input.monthlyRemuneration) /
      (config.etiWageCeiling - 4_500);
    monthlyEti = maxEti * taper;
  }

  return {
    isEligible: true,
    monthsEmployed,
    employmentYear,
    monthlyEti: Math.round(Math.max(0, monthlyEti) * 100) / 100,
  };
}
