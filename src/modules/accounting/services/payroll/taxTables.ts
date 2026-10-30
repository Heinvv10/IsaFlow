import { payeTaxYearOf } from '@/modules/accounting/utils/payeTaxYear';

export interface TaxBracket {
  from: number;
  to: number;
  baseTax: number;
  rate: number;
}

export interface TaxYearConfig {
  year: number;
  brackets: TaxBracket[];
  primaryRebate: number;
  secondaryRebate: number;
  tertiaryRebate: number;
  thresholdBelow65: number;
  threshold65to74: number;
  threshold75plus: number;
  medicalCreditMainAndFirst: number;
  medicalCreditAdditional: number;
  uifCeiling: number;
  sdlThresholdAnnual: number;
  /** Section 11F(2)(a): the most retirement fund contributions an employee may deduct in the year (retirementFund.ts). */
  retirementDeductionCap: number;
}

/** Thrown for a tax year with no registered tables; never answered with another year's figures. */
export class UnsupportedTaxYearError extends Error {
  readonly taxYear: number;
  constructor(taxYear: number) {
    super(
      `Payroll tax tables for tax year ${taxYear} (March ${taxYear - 1} to February ${taxYear}) `
      + 'are not loaded, so this period cannot be calculated. Add the SARS tables to taxTables.ts first.',
    );
    this.name = 'UnsupportedTaxYearError';
    this.taxYear = taxYear;
  }
}

// `from` is the bracket's lower bound as SARS publishes it (x01), so the tax is
// baseTax + rate × (income − (from − 1)); the first bracket therefore starts at 1.
const TAX_2025: TaxYearConfig = {
  year: 2025,
  brackets: [
    { from: 1,         to: 237_100,   baseTax: 0,       rate: 0.18 },
    { from: 237_101,   to: 370_500,   baseTax: 42_678,  rate: 0.26 },
    { from: 370_501,   to: 512_800,   baseTax: 77_362,  rate: 0.31 },
    { from: 512_801,   to: 673_000,   baseTax: 121_475, rate: 0.36 },
    { from: 673_001,   to: 857_900,   baseTax: 179_147, rate: 0.39 },
    { from: 857_901,   to: 1_817_000, baseTax: 251_258, rate: 0.41 },
    { from: 1_817_001, to: Infinity,  baseTax: 644_489, rate: 0.45 },
  ],
  primaryRebate:   17_235,
  secondaryRebate:  9_444,
  tertiaryRebate:   3_145,
  thresholdBelow65:  95_750,
  threshold65to74:  148_217,
  threshold75plus:  165_689,
  medicalCreditMainAndFirst: 364,
  medicalCreditAdditional:   246,
  uifCeiling:      17_712,
  sdlThresholdAnnual: 500_000,
  // R350 000 since the 1 March 2016 retirement reforms: SARS PAYE-GEN-01-G20 (2026 tax year) p. 5.
  retirementDeductionCap: 350_000,
};

const TAX_2026: TaxYearConfig = {
  ...TAX_2025,
  year: 2026,
};

// Tax year 2027 = 1 March 2026 to 28 February 2027 (SARS 2026/27).
// Source: https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/
// and https://www.sars.gov.za/tax-rates/medical-tax-credit-rates/ (retrieved 2026-10-18).
// The brackets, rebates, thresholds and medical credits are the SARS figures.
// uifCeiling and sdlThresholdAnnual are unchanged from 2026, checked against SARS on 2026-10-19:
// UIF: R17 712 a month "as from 1 June 2021" (https://www.sars.gov.za/types-of-tax/unemployment-insurance-fund/).
// SDL: employers whose leviable remuneration won't exceed R500 000 over the next 12 months are exempt; SARS
// gives no effective date (https://www.sars.gov.za/types-of-tax/skills-development-levy/).
const TAX_2027: TaxYearConfig = {
  year: 2027,
  brackets: [
    { from: 1,         to: 245_100,   baseTax: 0,       rate: 0.18 },
    { from: 245_101,   to: 383_100,   baseTax: 44_118,  rate: 0.26 },
    { from: 383_101,   to: 530_200,   baseTax: 79_998,  rate: 0.31 },
    { from: 530_201,   to: 695_800,   baseTax: 125_599, rate: 0.36 },
    { from: 695_801,   to: 887_000,   baseTax: 185_215, rate: 0.39 },
    { from: 887_001,   to: 1_878_600, baseTax: 259_783, rate: 0.41 },
    { from: 1_878_601, to: Infinity,  baseTax: 666_339, rate: 0.45 },
  ],
  primaryRebate:   17_820,
  secondaryRebate:  9_765,
  tertiaryRebate:   3_249,
  thresholdBelow65:  99_000,
  threshold65to74:  153_250,
  threshold75plus:  171_300,
  medicalCreditMainAndFirst: 376,
  medicalCreditAdditional:   254,
  // Same as 2026; SARS-checked 2026-10-19 (see above).
  uifCeiling:         TAX_2026.uifCeiling,
  sdlThresholdAnnual: TAX_2026.sdlThresholdAnnual,
  // R430 000 from 1 March 2026: SARS PAYE-GEN-01-G21 (2027 tax year) Rev 1 p. 5 and p. 10
  // (https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf).
  retirementDeductionCap: 430_000,
};

const TAX_TABLE_REGISTRY: Record<number, TaxYearConfig> = {
  2025: TAX_2025,
  2026: TAX_2026,
  2027: TAX_2027,
};

export function getTaxYear(periodMonth: number, periodYear: number): number {
  // SA tax year ends in February; March starts the new year (utils/payeTaxYear).
  // periodMonth 3 (March) of periodYear 2024 → taxYear 2025 (ends Feb 2025)
  return payeTaxYearOf(periodMonth, periodYear);
}

export function getTaxYearConfig(taxYear: number): TaxYearConfig {
  const config = TAX_TABLE_REGISTRY[taxYear];
  if (!config) throw new UnsupportedTaxYearError(taxYear);
  return config;
}

/** Why a pay period cannot be costed, or null when its tax year's tables are loaded. */
export function unloadedTaxYearMessage(periodMonth: number, periodYear: number): string | null {
  try {
    getTaxYearConfig(getTaxYear(periodMonth, periodYear));
    return null;
  } catch (err) {
    if (err instanceof UnsupportedTaxYearError) return err.message;
    throw err;
  }
}

export function computeAnnualTax(annualIncome: number, brackets: TaxBracket[]): number {
  for (const bracket of brackets) {
    if (annualIncome <= bracket.to) {
      return bracket.baseTax + bracket.rate * (annualIncome - bracket.from + 1);
    }
  }
  const last = brackets[brackets.length - 1];
  if (!last) {
    throw new Error('No tax brackets provided');
  }
  return last.baseTax + last.rate * (annualIncome - last.from + 1);
}
