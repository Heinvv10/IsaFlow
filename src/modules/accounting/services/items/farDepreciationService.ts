/**
 * FAR Depreciation Engine — Phase 1
 * Dual-track: IAS 16 policy depreciation + SARS wear & tear tax depreciation.
 * Pure business logic — no DB dependencies (fully testable).
 */

// ─── Input / Output types ─────────────────────────────────────────────────────

export interface PolicyDepreciationInput {
  cost: number;
  /** Residual value as a fraction of cost (0.10 = 10%). IAS 16: depreciable = cost × (1 − residualPct). */
  residualPct: number;
  usefulLifeYears: number;
  /** ISO date string — used to pro-rate the first month. */
  purchaseDate: string;
  /** ISO date string — last day of the period being computed. */
  periodDate: string;
  /** Accumulated policy depreciation from all prior periods (default 0). */
  openingAccDep?: number;
  /** If set and falls within this period, depreciation = 0 for the period. */
  disposalDate?: string;
}

export interface PolicyDepreciationResult {
  monthlyDep: number;
  annualDep: number;
  openingAccDep: number;
  closingAccDep: number;
  policyCarryingAmount: number;
  depRate: number;
}

export interface TaxDepreciationInput {
  cost: number;
  taxLifeYears: number;
  purchaseDate: string;
  periodDate: string;
  /** Opening accumulated tax depreciation from prior periods (default 0). */
  taxOpeningAccDep?: number;
  disposalDate?: string;
}

export interface TaxDepreciationResult {
  monthlyTaxDep: number;
  annualTaxDep: number;
  openingTaxAccDep: number;
  closingTaxAccDep: number;
  taxCarryingAmount: number;
}

export interface DeferredTaxInput {
  policyCarryingAmount: number;
  taxCarryingAmount: number;
  deferredTaxRate: number;
}

export interface DeferredTaxResult {
  temporaryDifference: number;
  deferredTax: number;
  /** true = liability (tax CA > policy CA); false = asset (policy CA > tax CA). */
  isLiability: boolean;
}

export interface CapitalizationInput {
  cost: number;
  threshold?: number;
}

export interface CapitalizationResult {
  belowThreshold: boolean;
  suggestedTreatment: 'expense' | 'capitalise';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(d: string | Date): Date {
  return typeof d === 'string' ? new Date(d) : d;
}

/** Days in a given month (year, 0-based month). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Returns true when the disposalDate falls on or before the last day of the
 * period (i.e. disposal occurred during or before this period).
 */
function disposedInOrBeforePeriod(disposalDate: string | undefined, periodDate: Date): boolean {
  if (!disposalDate) return false;
  const dd = parseDate(disposalDate);
  return dd <= periodDate;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Policy Depreciation (IAS 16) ─────────────────────────────────────────────

/**
 * Calculates monthly policy (IAS 16) depreciation for a single period.
 *
 * Rules:
 * - Straight-line on depreciable amount (cost × (1 − residualPct))
 * - Pro-rates the first month based on days remaining after purchase date
 * - Caps at remaining depreciable amount (cannot over-depreciate)
 * - Zero depreciation in any period after disposal
 */
export function calculatePolicyDepreciation(input: PolicyDepreciationInput): PolicyDepreciationResult {
  const {
    cost,
    residualPct,
    usefulLifeYears,
    purchaseDate,
    periodDate: periodDateStr,
    openingAccDep = 0,
    disposalDate,
  } = input;

  const periodDate = parseDate(periodDateStr);

  if (disposedInOrBeforePeriod(disposalDate, periodDate)) {
    return {
      monthlyDep: 0,
      annualDep: 0,
      openingAccDep,
      closingAccDep: openingAccDep,
      policyCarryingAmount: round2(cost - openingAccDep),
      depRate: 0,
    };
  }

  const depreciableAmount = round2(cost * (1 - residualPct));
  if (depreciableAmount <= 0 || usefulLifeYears <= 0) {
    return {
      monthlyDep: 0,
      annualDep: 0,
      openingAccDep,
      closingAccDep: openingAccDep,
      policyCarryingAmount: round2(cost - openingAccDep),
      depRate: 0,
    };
  }

  const annualDep = round2(depreciableAmount / usefulLifeYears);
  const fullMonthlyDep = round2(annualDep / 12);
  const depRate = round2((annualDep / cost) * 100) / 100;

  // Pro-rate first period if asset was purchased part-way through the month
  const pd = parseDate(purchaseDate);
  const periodYear = periodDate.getFullYear();
  const periodMonth = periodDate.getMonth();
  const purchaseYear = pd.getFullYear();
  const purchaseMonth = pd.getMonth();

  let monthlyDep = fullMonthlyDep;

  const isFirstMonth =
    purchaseYear === periodYear && purchaseMonth === periodMonth;

  if (isFirstMonth) {
    const totalDays = daysInMonth(periodYear, periodMonth);
    // Days from purchase day to end of month (inclusive of purchase date)
    const daysRemaining = totalDays - pd.getDate() + 1;
    monthlyDep = round2(fullMonthlyDep * (daysRemaining / totalDays));
  }

  // Cap at remaining depreciable amount
  const remainingDepreciable = round2(depreciableAmount - openingAccDep);
  if (remainingDepreciable <= 0) {
    return {
      monthlyDep: 0,
      annualDep,
      openingAccDep,
      closingAccDep: openingAccDep,
      policyCarryingAmount: round2(cost - openingAccDep),
      depRate,
    };
  }

  monthlyDep = round2(Math.min(monthlyDep, remainingDepreciable));

  const closingAccDep = round2(openingAccDep + monthlyDep);
  const policyCarryingAmount = round2(cost - closingAccDep);

  return { monthlyDep, annualDep, openingAccDep, closingAccDep, policyCarryingAmount, depRate };
}

// ─── Tax Depreciation (SARS Wear & Tear) ──────────────────────────────────────

/**
 * Calculates monthly SARS wear & tear (tax) depreciation for a single period.
 *
 * SARS rules:
 * - No residual value — always depreciate the full cost to zero
 * - Depreciation starts in the month FOLLOWING the acquisition month
 * - Caps at cost (cannot exceed purchase price)
 * - Zero depreciation in any period after disposal
 */
export function calculateTaxDepreciation(input: TaxDepreciationInput): TaxDepreciationResult {
  const {
    cost,
    taxLifeYears,
    purchaseDate,
    periodDate: periodDateStr,
    taxOpeningAccDep = 0,
    disposalDate,
  } = input;

  const periodDate = parseDate(periodDateStr);

  if (disposedInOrBeforePeriod(disposalDate, periodDate)) {
    return {
      monthlyTaxDep: 0,
      annualTaxDep: 0,
      openingTaxAccDep: taxOpeningAccDep,
      closingTaxAccDep: taxOpeningAccDep,
      taxCarryingAmount: round2(cost - taxOpeningAccDep),
    };
  }

  // SARS: depreciation starts the month AFTER acquisition
  const pd = parseDate(purchaseDate);
  const acquisitionYYYYMM = pd.getFullYear() * 100 + (pd.getMonth() + 1);
  const periodYYYYMM = periodDate.getFullYear() * 100 + (periodDate.getMonth() + 1);

  if (periodYYYYMM <= acquisitionYYYYMM) {
    return {
      monthlyTaxDep: 0,
      annualTaxDep: 0,
      openingTaxAccDep: taxOpeningAccDep,
      closingTaxAccDep: taxOpeningAccDep,
      taxCarryingAmount: round2(cost - taxOpeningAccDep),
    };
  }

  const annualTaxDep = round2(cost / taxLifeYears);
  const fullMonthlyTaxDep = round2(annualTaxDep / 12);

  const remaining = round2(cost - taxOpeningAccDep);
  if (remaining <= 0) {
    return {
      monthlyTaxDep: 0,
      annualTaxDep,
      openingTaxAccDep: taxOpeningAccDep,
      closingTaxAccDep: taxOpeningAccDep,
      taxCarryingAmount: 0,
    };
  }

  const monthlyTaxDep = round2(Math.min(fullMonthlyTaxDep, remaining));
  const closingTaxAccDep = round2(taxOpeningAccDep + monthlyTaxDep);
  const taxCarryingAmount = round2(cost - closingTaxAccDep);

  return { monthlyTaxDep, annualTaxDep, openingTaxAccDep: taxOpeningAccDep, closingTaxAccDep, taxCarryingAmount };
}

// ─── Deferred Tax ─────────────────────────────────────────────────────────────

/**
 * Calculates deferred tax from the temporary difference between tax and policy
 * carrying amounts.
 *
 * Formula: (taxCA − policyCA) × deferredTaxRate
 * Positive = liability (tax CA > policy CA)
 * Negative = asset  (policy CA > tax CA)
 */
export function calculateDeferredTax(input: DeferredTaxInput): DeferredTaxResult {
  const { policyCarryingAmount, taxCarryingAmount, deferredTaxRate } = input;
  const temporaryDifference = round2(taxCarryingAmount - policyCarryingAmount);
  const deferredTax = round2(temporaryDifference * deferredTaxRate);
  return {
    temporaryDifference,
    deferredTax,
    isLiability: temporaryDifference > 0,
  };
}

// ─── Capitalization Threshold ─────────────────────────────────────────────────

const DEFAULT_CAP_THRESHOLD = 5_000;

/**
 * Checks whether an asset should be expensed immediately rather than capitalised.
 * Default SARS guidance threshold is R5 000.
 */
export function checkCapitalizationThreshold(input: CapitalizationInput): CapitalizationResult {
  const { cost, threshold = DEFAULT_CAP_THRESHOLD } = input;
  const belowThreshold = cost < threshold;
  return {
    belowThreshold,
    suggestedTreatment: belowThreshold ? 'expense' : 'capitalise',
  };
}
