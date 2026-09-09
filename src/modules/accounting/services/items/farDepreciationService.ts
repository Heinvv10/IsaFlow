/**
 * FAR Depreciation Engine — Phase 1
 * Dual-track: IAS 16 policy depreciation + SARS wear & tear tax depreciation.
 * Pure business logic — no DB dependencies (fully testable).
 */

// Policy (IAS 16) depreciation moved to `depreciationMethods.ts` when adding the
// per-asset method pushed this file past the 300-line cap. Re-exported so every
// existing importer of this module is unchanged.
export {
  annualPolicyCharge,
  calculatePolicyDepreciation,
  toDepreciationMethod,
  type DepreciationMethod,
  type PolicyDepreciationInput,
  type PolicyDepreciationResult,
} from './depreciationMethods';

// ─── Input / Output types ─────────────────────────────────────────────────────

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
