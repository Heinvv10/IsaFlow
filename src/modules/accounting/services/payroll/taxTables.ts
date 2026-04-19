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
  etiYearOneMax: number;
  etiYearTwoMax: number;
  etiWageCeiling: number;
  etiWageFloor: number;
}

const TAX_2025: TaxYearConfig = {
  year: 2025,
  brackets: [
    { from: 0,         to: 237_100,   baseTax: 0,       rate: 0.18 },
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
  etiYearOneMax:    1_500,
  etiYearTwoMax:      750,
  etiWageCeiling:   7_500,
  etiWageFloor:     2_000,
};

const TAX_2026: TaxYearConfig = {
  ...TAX_2025,
  year: 2026,
};

const TAX_TABLE_REGISTRY: Record<number, TaxYearConfig> = {
  2025: TAX_2025,
  2026: TAX_2026,
};

export function getTaxYear(periodMonth: number, periodYear: number): number {
  // SA tax year ends in February; March starts the new year.
  // periodMonth 3 (March) of periodYear 2024 → taxYear 2025 (ends Feb 2025)
  return periodMonth >= 3 ? periodYear + 1 : periodYear;
}

export function getTaxYearConfig(taxYear: number): TaxYearConfig {
  const config = TAX_TABLE_REGISTRY[taxYear];
  if (!config) {
    const latestYear = Math.max(...Object.keys(TAX_TABLE_REGISTRY).map(Number));
    const fallback = TAX_TABLE_REGISTRY[latestYear];
    if (!fallback) {
      throw new Error(`No tax configuration found for year ${taxYear}`);
    }
    return fallback;
  }
  return config;
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
