/**
 * SARS Tax Tables 2025/2026
 * Tax year: 1 March 2025 - 28 February 2026
 * Accurate to the cent per SARS published rates.
 */

// ── Tax Brackets ────────────────────────────────────────────────────────────

interface TaxBracket {
  min: number;
  max: number;
  rate: number;
  baseTax: number;
}

const TAX_BRACKETS: TaxBracket[] = [
  { min: 0,       max: 237100,  rate: 0.18, baseTax: 0 },
  { min: 237101,  max: 370500,  rate: 0.26, baseTax: 42678 },
  { min: 370501,  max: 512800,  rate: 0.31, baseTax: 77362 },
  { min: 512801,  max: 673000,  rate: 0.36, baseTax: 121475 },
  { min: 673001,  max: 857900,  rate: 0.39, baseTax: 179147 },
  { min: 857901,  max: 1817000, rate: 0.41, baseTax: 251258 },
  { min: 1817001, max: Infinity, rate: 0.45, baseTax: 644489 },
];

// ── Tax Rebates ─────────────────────────────────────────────────────────────

const PRIMARY_REBATE = 17235;
const SECONDARY_REBATE = 9444;  // Age 65+
const TERTIARY_REBATE = 3145;   // Age 75+

// ── Tax Thresholds (derived from rebates / lowest bracket rate) ─────────

const TAX_THRESHOLD_UNDER_65 = 95750;   // R17,235 / 18%
const TAX_THRESHOLD_65_TO_74 = 148217;  // (R17,235 + R9,444) / 18%
const TAX_THRESHOLD_75_PLUS = 165689;   // (R17,235 + R9,444 + R3,145) / 18%

// ── Medical Aid Credits ─────────────────────────────────────────────────────

const MEDICAL_CREDIT_MAIN = 364;         // per month
const MEDICAL_CREDIT_FIRST_DEP = 364;    // per month
const MEDICAL_CREDIT_ADDITIONAL = 246;   // per month per additional dependant

// ── UIF ─────────────────────────────────────────────────────────────────────

const UIF_RATE = 0.01;
const UIF_MONTHLY_CEILING = 17712;
const UIF_MAX_MONTHLY = 177.12;

// ── SDL ─────────────────────────────────────────────────────────────────────

const SDL_RATE = 0.01;

// ── Calculation Functions ───────────────────────────────────────────────────

/**
 * Calculate annual PAYE tax for a given annual taxable income and age.
 * Returns the annual tax amount (>= 0).
 *
 * Steps:
 * 1. Apply tax brackets to get gross tax
 * 2. Subtract primary rebate (all taxpayers)
 * 3. Subtract secondary rebate (age >= 65)
 * 4. Subtract tertiary rebate (age >= 75)
 * 5. Result cannot be negative
 */
export function calculatePAYE(annualTaxableIncome: number, age: number): number {
  if (annualTaxableIncome <= 0) return 0;

  // Check threshold — if below, no tax is due
  let threshold = TAX_THRESHOLD_UNDER_65;
  if (age >= 75) {
    threshold = TAX_THRESHOLD_75_PLUS;
  } else if (age >= 65) {
    threshold = TAX_THRESHOLD_65_TO_74;
  }

  if (annualTaxableIncome <= threshold) return 0;

  // Find applicable bracket
  let grossTax = 0;
  for (const bracket of TAX_BRACKETS) {
    if (annualTaxableIncome >= bracket.min) {
      if (annualTaxableIncome <= bracket.max) {
        if (bracket.min === 0) {
          grossTax = annualTaxableIncome * bracket.rate;
        } else {
          grossTax = bracket.baseTax + (annualTaxableIncome - bracket.min) * bracket.rate;
        }
        break;
      }
    }
  }

  // Apply rebates
  let rebate = PRIMARY_REBATE;
  if (age >= 65) rebate += SECONDARY_REBATE;
  if (age >= 75) rebate += TERTIARY_REBATE;

  const netTax = grossTax - rebate;
  return Math.max(0, Math.round(netTax * 100) / 100);
}

/**
 * Calculate monthly PAYE from monthly taxable income.
 * Annualises, calculates, then divides by 12.
 */
export function calculateMonthlyPAYE(
  monthlyTaxableIncome: number,
  age: number
): number {
  const annualIncome = monthlyTaxableIncome * 12;
  const annualTax = calculatePAYE(annualIncome, age);
  return Math.round((annualTax / 12) * 100) / 100;
}

/**
 * Calculate UIF contributions for employee and employer.
 * Each pays 1% of remuneration, capped at R177.12/month.
 */
export function calculateUIF(monthlyRemuneration: number): {
  employee: number;
  employer: number;
} {
  const cappedRemuneration = Math.min(monthlyRemuneration, UIF_MONTHLY_CEILING);
  const contribution = Math.round(cappedRemuneration * UIF_RATE * 100) / 100;
  return {
    employee: Math.min(contribution, UIF_MAX_MONTHLY),
    employer: Math.min(contribution, UIF_MAX_MONTHLY),
  };
}

/**
 * Calculate SDL (Skills Development Levy).
 * Employer pays 1% of total monthly payroll.
 */
export function calculateSDL(totalPayroll: number): number {
  return Math.round(totalPayroll * SDL_RATE * 100) / 100;
}

/**
 * Calculate monthly medical aid tax credits.
 */
export function calculateMedicalCredits(
  mainMember: boolean,
  dependants: number
): number {
  if (!mainMember) return 0;
  let credit = MEDICAL_CREDIT_MAIN;
  if (dependants >= 1) {
    credit += MEDICAL_CREDIT_FIRST_DEP;
    if (dependants > 1) {
      credit += (dependants - 1) * MEDICAL_CREDIT_ADDITIONAL;
    }
  }
  return credit;
}

/**
 * Calculate the age of a person given their ID number (YYMMDD format)
 * or a birth date, relative to a reference date.
 */
export function calculateAgeFromIdNumber(
  idNumber: string,
  referenceDate: Date = new Date()
): number {
  if (!idNumber || idNumber.length < 6) return 30; // default assumption

  const yy = parseInt(idNumber.substring(0, 2), 10);
  const mm = parseInt(idNumber.substring(2, 4), 10) - 1;
  const dd = parseInt(idNumber.substring(4, 6), 10);

  // SA IDs: 00-29 = 2000s, 30-99 = 1900s
  const year = yy <= 29 ? 2000 + yy : 1900 + yy;
  const birthDate = new Date(year, mm, dd);

  let age = referenceDate.getFullYear() - birthDate.getFullYear();
  const monthDiff = referenceDate.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}
