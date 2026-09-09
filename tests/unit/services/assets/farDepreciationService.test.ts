import { describe, it, expect } from 'vitest';
import {
  calculatePolicyDepreciation,
  calculateTaxDepreciation,
  calculateDeferredTax,
  checkCapitalizationThreshold,
  toDepreciationMethod,
  type DepreciationMethod,
  type PolicyDepreciationInput,
  type TaxDepreciationInput,
  type DeferredTaxInput,
  type CapitalizationInput,
} from '@/modules/accounting/services/items/farDepreciationService';
import { lifeExpiredNote } from '@/modules/accounting/services/items/depreciationMethods';

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

// ─── K-029: the configured method drives the charge ──────────────────────────

describe('calculatePolicyDepreciation — depreciation method (K-029)', () => {
  const base: PolicyDepreciationInput = {
    cost: 100_000,
    residualPct: 0,
    usefulLifeYears: 5,
    purchaseDate: '2024-01-15',
    periodDate: '2026-09-30',   // month 32 → depreciation year 3
    openingAccDep: 20_000,
  };

  it('defaults to straight line when no method is given', () => {
    // 100 000 / 5 / 12 = 1 666.67
    expect(calculatePolicyDepreciation(base).monthlyDep).toBeCloseTo(1_666.67, 2);
    expect(calculatePolicyDepreciation({ ...base, method: 'straight_line' }).monthlyDep)
      .toBeCloseTo(1_666.67, 2);
  });

  it('charges reducing balance off the year-opening carrying amount', () => {
    // Year 1 opens at 100 000: × 2/5 = 40 000 → 3 333.33 per month.
    const y1 = calculatePolicyDepreciation({
      ...base, periodDate: '2024-06-30', openingAccDep: 0, method: 'reducing_balance',
    });
    expect(y1.annualDep).toBeCloseTo(40_000, 2);
    expect(y1.monthlyDep).toBeCloseTo(3_333.33, 2);
    // Year 3 opens at 36 000: × 2/5 = 14 400 → 1 200 per month.
    const y3 = calculatePolicyDepreciation({ ...base, method: 'reducing_balance' });
    expect(y3.annualDep).toBeCloseTo(14_400, 2);
    expect(y3.monthlyDep).toBeCloseTo(1_200, 2);
  });

  it('holds the declining charge flat across a year rather than compounding it monthly', () => {
    // Every month of year 1 charges the same, whatever the accumulated balance
    // has reached. Compounding monthly charged 33 423.51 in year one against a
    // stated 40% rate.
    const args = { ...base, periodDate: '2024-06-30', method: 'reducing_balance' as const };
    expect(calculatePolicyDepreciation({ ...args, openingAccDep: 0 }).monthlyDep)
      .toBeCloseTo(calculatePolicyDepreciation({ ...args, openingAccDep: 16_666.65 }).monthlyDep, 2);
  });

  it('switches reducing balance to straight line over the remaining life', () => {
    // Year 4 opens at 21 600. Declining would take 8 640; spreading the
    // remaining 21 600 over the last 2 years takes 10 800, so the schedule
    // switches and lands on the residual at the end of the life.
    const y4 = calculatePolicyDepreciation({
      ...base, periodDate: '2027-06-30', openingAccDep: 78_400, method: 'reducing_balance',
    });
    expect(y4.annualDep).toBeCloseTo(10_800, 2);
  });

  it('caps reducing balance at the residual, never below it', () => {
    // Depreciable = 100 000 × 0.8 = 80 000; already 79 900 taken, so 100 left.
    const result = calculatePolicyDepreciation({
      ...base, residualPct: 0.2, openingAccDep: 79_900, method: 'reducing_balance',
    });
    expect(result.monthlyDep).toBeCloseTo(100, 2);
    expect(result.closingAccDep).toBeCloseTo(80_000, 2);
    expect(result.policyCarryingAmount).toBeCloseTo(20_000, 2);
  });

  it('charges sum-of-years on the remaining years of the life', () => {
    // 3-year life, purchased 2024-01, period 2026-09 → 2 whole years elapsed,
    // 1 remaining: 60 000 × 1 / 6 / 12 = 833.33
    expect(
      calculatePolicyDepreciation({
        ...base, cost: 60_000, usefulLifeYears: 3, openingAccDep: 0, method: 'sum_of_years',
      }).monthlyDep,
    ).toBeCloseTo(833.33, 2);
  });

  it('charges sum-of-years its highest amount in the first year', () => {
    // Period inside year one: 60 000 × 3 / 6 / 12 = 2 500
    expect(
      calculatePolicyDepreciation({
        ...base, cost: 60_000, usefulLifeYears: 3, openingAccDep: 0,
        periodDate: '2024-06-30', method: 'sum_of_years',
      }).monthlyDep,
    ).toBe(2_500);
  });

  it('charges nothing under any method once the schedule is complete', () => {
    for (const method of ['straight_line', 'reducing_balance', 'sum_of_years'] as const) {
      expect(
        calculatePolicyDepreciation({
          ...base, cost: 60_000, usefulLifeYears: 3, openingAccDep: 60_000,
          periodDate: '2028-09-30', method,
        }).monthlyDep,
      ).toBe(0);
    }
  });

  it('pro-rates the first month under every method', () => {
    // Purchased 2024-01-15 → 17 of 31 days. Reducing balance year one is
    // 100 000 × 2/5 = 40 000 → 3 333.33 full month; pro-rated = 1 827.96.
    expect(
      calculatePolicyDepreciation({
        ...base, openingAccDep: 0, periodDate: '2024-01-31', method: 'reducing_balance',
      }).monthlyDep,
    ).toBeCloseTo(1_827.96, 2);
  });

  it('charges nothing after disposal regardless of method', () => {
    expect(
      calculatePolicyDepreciation({ ...base, method: 'reducing_balance', disposalDate: '2026-05-31' })
        .monthlyDep,
    ).toBe(0);
  });
});

/**
 * The schedule must terminate. Declining balance without a crossover only
 * approaches the residual (13.1% of cost was still on the books at the end of a
 * five-year life, and the run posted a journal for it every month after), and
 * sum-of-years hard-stopped at the life while the pro-rated first month was
 * still unrecovered.
 */
describe('calculatePolicyDepreciation — the full life (K-029)', () => {
  const COST = 100_000;
  const LIFE = 5;

  /** Runs one journal per month from acquisition to well past the life. */
  function runToExhaustion(method: DepreciationMethod, residualPct: number) {
    let accDep = 0;
    const charges: number[] = [];
    for (let m = 0; m < LIFE * 12 + 24; m += 1) {
      // Purchased 2024-01-15; period = last day of the month m months later.
      const period = new Date(2024, 0 + m + 1, 0);
      const result = calculatePolicyDepreciation({
        cost: COST,
        residualPct,
        usefulLifeYears: LIFE,
        purchaseDate: '2024-01-15',
        periodDate: period.toISOString().slice(0, 10),
        openingAccDep: accDep,
        method,
      });
      charges.push(result.monthlyDep);
      accDep = result.closingAccDep;
    }
    return { charges, accDep, afterLife: charges.slice(LIFE * 12) };
  }

  for (const method of ['straight_line', 'reducing_balance', 'sum_of_years'] as const) {
    it(`${method} charges the depreciable amount exactly and then stops`, () => {
      const { charges, accDep, afterLife } = runToExhaustion(method, 0);
      expect(charges.reduce((t, c) => t + c, 0)).toBeCloseTo(COST, 2);
      expect(accDep).toBeCloseTo(COST, 2);
      // Not one journal after the useful life expires.
      expect(afterLife.filter((c) => c > 0)).toEqual([]);
    });

    it(`${method} stops exactly on a 10% residual`, () => {
      const { accDep, afterLife } = runToExhaustion(method, 0.1);
      expect(accDep).toBeCloseTo(90_000, 2);
      expect(afterLife.filter((c) => c > 0)).toEqual([]);
    });
  }
});

/**
 * Follow-up review HIGH-A. The final-month true-up used `>=`, so an asset whose
 * life had already expired with book value on it was handed its ENTIRE
 * remaining book value as one month's charge on the first run after deploy —
 * exactly what a part-migrated register is full of.
 */
describe('calculatePolicyDepreciation — an asset already past its life (HIGH-A)', () => {
  // R100 000, 5-year life, no residual, bought 2015-01-31, only R40 000 taken.
  // Month 140 of a 60-month life; R60 000 still undepreciated.
  const expired: PolicyDepreciationInput = {
    cost: 100_000,
    residualPct: 0,
    usefulLifeYears: 5,
    purchaseDate: '2015-01-31',
    periodDate: '2026-09-30',
    openingAccDep: 40_000,
  };

  for (const method of ['straight_line', 'reducing_balance', 'sum_of_years'] as const) {
    it(`charges nothing rather than dumping the whole balance — ${method}`, () => {
      const result = calculatePolicyDepreciation({ ...expired, method });
      expect(result.monthlyDep).toBe(0);
      // The balance stays where it is; it is not swept into this month.
      expect(result.closingAccDep).toBeCloseTo(40_000, 2);
      expect(result.policyCarryingAmount).toBeCloseTo(60_000, 2);
    });
  }

  it('still trues up in the final month of the life itself', () => {
    // Month 59 of a 5-year life: 2015-01-31 + 59 months = 2019-12-31.
    const result = calculatePolicyDepreciation({ ...expired, periodDate: '2019-12-31' });
    expect(result.monthlyDep).toBeCloseTo(60_000, 2);
  });
});

describe('lifeExpiredNote', () => {
  const base = {
    cost: 100_000, residual: 0, usefulLifeYears: 5,
    monthsElapsed: 140, policyAccDep: 40_000, periodDate: '2026-09-30',
  };

  it('names the undepreciated balance an expired asset still carries', () => {
    const note = lifeExpiredNote(base);
    expect(note).toContain('60000.00');
    expect(note).toContain('prior-period correction');
  });

  it('says nothing while the life still has months to run', () => {
    expect(lifeExpiredNote({ ...base, monthsElapsed: 59 })).toBeNull();
  });

  it('says nothing once the asset is fully depreciated', () => {
    expect(lifeExpiredNote({ ...base, policyAccDep: 100_000 })).toBeNull();
  });

  it('measures the balance against the residual, not against cost', () => {
    // 10% residual: depreciable is 90 000, of which 90 000 is taken.
    expect(lifeExpiredNote({ ...base, residual: 10_000, policyAccDep: 90_000 })).toBeNull();
    expect(lifeExpiredNote({ ...base, residual: 10_000, policyAccDep: 80_000 })).toContain('10000.00');
  });
});

describe('toDepreciationMethod', () => {
  it('accepts the three asset methods', () => {
    expect(toDepreciationMethod('straight_line')).toBe('straight_line');
    expect(toDepreciationMethod('reducing_balance')).toBe('reducing_balance');
    expect(toDepreciationMethod('sum_of_years')).toBe('sum_of_years');
  });

  it('folds the asset_categories vocabulary onto the asset one', () => {
    // Defensive only: migration 360 calls reducing balance `diminishing_balance`
    // on asset_categories, and no run path reads the method from there.
    expect(toDepreciationMethod('diminishing_balance')).toBe('reducing_balance');
  });

  it('falls back to straight line for null and unknown values', () => {
    expect(toDepreciationMethod(null)).toBe('straight_line');
    expect(toDepreciationMethod(undefined)).toBe('straight_line');
    expect(toDepreciationMethod('annuity')).toBe('straight_line');
  });
});
