import { describe, it, expect } from 'vitest';
import {
  calculatePolicyDepreciation,
  calculateTaxDepreciation,
  calculateDeferredTax,
  checkCapitalizationThreshold,
  type PolicyDepreciationInput,
  type TaxDepreciationInput,
  type DeferredTaxInput,
  type CapitalizationInput,
} from '@/modules/accounting/services/items/farDepreciationService';

// ─── Policy Depreciation (IAS 16) ────────────────────────────────────────────

describe('calculatePolicyDepreciation', () => {
  const base: PolicyDepreciationInput = {
    cost: 120_000,
    residualPct: 0.1,         // 10% residual → depreciable = 108 000
    usefulLifeYears: 5,
    purchaseDate: '2022-01-01',
    periodDate: '2022-01-31', // first full month
  };

  it('calculates monthly amount for straight-line', () => {
    const result = calculatePolicyDepreciation(base);
    // depreciable = 120 000 × 0.9 = 108 000; annual = 21 600; monthly = 1 800
    expect(result.monthlyDep).toBeCloseTo(1_800, 2);
  });

  it('returns carrying amount after first month', () => {
    const result = calculatePolicyDepreciation(base);
    // CA = cost − acc dep after 1 month = 120 000 − 1 800 = 118 200
    expect(result.policyCarryingAmount).toBeCloseTo(118_200, 2);
  });

  it('pro-rates first period if purchased mid-month', () => {
    const input: PolicyDepreciationInput = {
      ...base,
      purchaseDate: '2022-01-16', // 16 days remaining in Jan (16 of 31)
      periodDate: '2022-01-31',
    };
    const result = calculatePolicyDepreciation(input);
    // 1 800 × (16/31) ≈ 929.03
    expect(result.monthlyDep).toBeCloseTo(1_800 * (16 / 31), 2);
  });

  it('caps depreciation at depreciable amount', () => {
    const input: PolicyDepreciationInput = {
      cost: 12_000,
      residualPct: 0,
      usefulLifeYears: 1,
      purchaseDate: '2020-01-01',
      periodDate: '2030-01-31',   // way past useful life
      openingAccDep: 12_000,
    };
    const result = calculatePolicyDepreciation(input);
    expect(result.monthlyDep).toBe(0);
    expect(result.policyCarryingAmount).toBe(0);
  });

  it('stops depreciation after disposal date', () => {
    const input: PolicyDepreciationInput = {
      ...base,
      disposalDate: '2022-01-15',
      periodDate: '2022-01-31',
    };
    const result = calculatePolicyDepreciation(input);
    expect(result.monthlyDep).toBe(0);
  });

  it('returns zero when cost equals residual', () => {
    const input: PolicyDepreciationInput = {
      ...base,
      residualPct: 1.0, // 100% residual → nothing to depreciate
    };
    const result = calculatePolicyDepreciation(input);
    expect(result.monthlyDep).toBe(0);
  });

  it('handles accumulated depreciation from prior periods', () => {
    const input: PolicyDepreciationInput = {
      ...base,
      openingAccDep: 90_000, // only 18 000 left to depreciate
    };
    const result = calculatePolicyDepreciation(input);
    // Normal monthly = 1 800; remaining = 108 000 − 90 000 = 18 000 → 10 more months
    expect(result.monthlyDep).toBeCloseTo(1_800, 2);
    expect(result.closingAccDep).toBeCloseTo(91_800, 2);
  });

  it('caps at remaining depreciable amount when near fully depreciated', () => {
    const input: PolicyDepreciationInput = {
      ...base,
      openingAccDep: 107_500, // only 500 left
    };
    const result = calculatePolicyDepreciation(input);
    expect(result.monthlyDep).toBeCloseTo(500, 2);
  });
});

// ─── Tax Depreciation (SARS Wear & Tear) ─────────────────────────────────────

describe('calculateTaxDepreciation', () => {
  const base: TaxDepreciationInput = {
    cost: 120_000,
    taxLifeYears: 3,             // 3-year SARS life → annual = 40 000; monthly = 3 333.33
    purchaseDate: '2022-01-01',
    periodDate: '2022-02-28',    // SARS: starts month AFTER purchase (Feb is first month)
  };

  it('calculates monthly tax depreciation correctly', () => {
    const result = calculateTaxDepreciation(base);
    expect(result.monthlyTaxDep).toBeCloseTo(3_333.33, 2);
  });

  it('does NOT depreciate in the month of purchase (SARS rule)', () => {
    const input: TaxDepreciationInput = {
      ...base,
      periodDate: '2022-01-31', // same month as purchase
    };
    const result = calculateTaxDepreciation(input);
    expect(result.monthlyTaxDep).toBe(0);
  });

  it('uses no residual value (SARS depreciates to zero)', () => {
    const result = calculateTaxDepreciation(base);
    // full cost is depreciable — not cost minus residual
    const expected = 120_000 / (3 * 12);
    expect(result.monthlyTaxDep).toBeCloseTo(expected, 2);
  });

  it('caps tax depreciation at cost (cannot exceed cost)', () => {
    const input: TaxDepreciationInput = {
      ...base,
      taxOpeningAccDep: 119_800, // only 200 remaining
    };
    const result = calculateTaxDepreciation(input);
    expect(result.monthlyTaxDep).toBeCloseTo(200, 2);
  });

  it('returns zero when fully depreciated', () => {
    const input: TaxDepreciationInput = {
      ...base,
      taxOpeningAccDep: 120_000,
    };
    const result = calculateTaxDepreciation(input);
    expect(result.monthlyTaxDep).toBe(0);
    expect(result.taxCarryingAmount).toBe(0);
  });

  it('stops tax depreciation after disposal date', () => {
    const input: TaxDepreciationInput = {
      ...base,
      disposalDate: '2022-02-10',
    };
    const result = calculateTaxDepreciation(input);
    expect(result.monthlyTaxDep).toBe(0);
  });

  it('returns taxCarryingAmount = cost − taxAccDep', () => {
    const input: TaxDepreciationInput = {
      ...base,
      taxOpeningAccDep: 10_000,
    };
    const result = calculateTaxDepreciation(input);
    const expectedTaxCA = 120_000 - 10_000 - result.monthlyTaxDep;
    expect(result.taxCarryingAmount).toBeCloseTo(expectedTaxCA, 2);
  });
});

// ─── Deferred Tax ─────────────────────────────────────────────────────────────

describe('calculateDeferredTax', () => {
  it('calculates deferred tax liability when tax CA > policy CA', () => {
    // Tax CA higher → positive temporary difference → deferred tax liability
    const input: DeferredTaxInput = {
      policyCarryingAmount: 80_000,
      taxCarryingAmount: 100_000,
      deferredTaxRate: 0.27,
    };
    const result = calculateDeferredTax(input);
    // (100 000 − 80 000) × 0.27 = 5 400
    expect(result.temporaryDifference).toBeCloseTo(20_000, 2);
    expect(result.deferredTax).toBeCloseTo(5_400, 2);
    expect(result.isLiability).toBe(true);
  });

  it('calculates deferred tax asset when policy CA > tax CA', () => {
    const input: DeferredTaxInput = {
      policyCarryingAmount: 100_000,
      taxCarryingAmount: 80_000,
      deferredTaxRate: 0.27,
    };
    const result = calculateDeferredTax(input);
    expect(result.temporaryDifference).toBeCloseTo(-20_000, 2);
    expect(result.deferredTax).toBeCloseTo(-5_400, 2);
    expect(result.isLiability).toBe(false);
  });

  it('returns zero deferred tax when carrying amounts are equal', () => {
    const input: DeferredTaxInput = {
      policyCarryingAmount: 50_000,
      taxCarryingAmount: 50_000,
      deferredTaxRate: 0.27,
    };
    const result = calculateDeferredTax(input);
    expect(result.deferredTax).toBe(0);
    expect(result.temporaryDifference).toBe(0);
  });

  it('supports 28% transition rate', () => {
    const input: DeferredTaxInput = {
      policyCarryingAmount: 70_000,
      taxCarryingAmount: 100_000,
      deferredTaxRate: 0.28,
    };
    const result = calculateDeferredTax(input);
    expect(result.deferredTax).toBeCloseTo(30_000 * 0.28, 2);
  });
});

// ─── Capitalization Threshold ─────────────────────────────────────────────────

describe('checkCapitalizationThreshold', () => {
  it('flags asset as below threshold when cost < threshold', () => {
    const input: CapitalizationInput = {
      cost: 3_500,
      threshold: 5_000,
    };
    const result = checkCapitalizationThreshold(input);
    expect(result.belowThreshold).toBe(true);
  });

  it('does not flag asset when cost equals threshold', () => {
    const input: CapitalizationInput = {
      cost: 5_000,
      threshold: 5_000,
    };
    const result = checkCapitalizationThreshold(input);
    expect(result.belowThreshold).toBe(false);
  });

  it('does not flag asset when cost exceeds threshold', () => {
    const input: CapitalizationInput = {
      cost: 15_000,
      threshold: 5_000,
    };
    const result = checkCapitalizationThreshold(input);
    expect(result.belowThreshold).toBe(false);
  });

  it('uses default 5 000 threshold when none provided', () => {
    const input: CapitalizationInput = {
      cost: 4_999,
    };
    const result = checkCapitalizationThreshold(input);
    expect(result.belowThreshold).toBe(true);
  });

  it('returns expense journal suggestion for below-threshold assets', () => {
    const input: CapitalizationInput = {
      cost: 2_000,
      threshold: 5_000,
    };
    const result = checkCapitalizationThreshold(input);
    expect(result.belowThreshold).toBe(true);
    expect(result.suggestedTreatment).toBe('expense');
  });

  it('returns capitalise treatment for above-threshold assets', () => {
    const input: CapitalizationInput = {
      cost: 10_000,
      threshold: 5_000,
    };
    const result = checkCapitalizationThreshold(input);
    expect(result.suggestedTreatment).toBe('capitalise');
  });
});
