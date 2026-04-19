import { describe, it, expect } from 'vitest';
import {
  aggregatePpeMovements,
  aggregateDeferredTax,
  type AssetPriorYearSnapshot,
  type AssetCurrentYearMovement,
  type PpeGroupMovement,
  type DeferredTaxCategoryRow,
} from '@/modules/accounting/services/items/farAfsService';

// ─── PPE Movement Note (IAS 16) ───────────────────────────────────────────────
//
// Structure per PRD section 5.1:
//   Opening balance   = prior year cost, acc dep, CA
//   Additions         = new assets acquired in year (cost only)
//   Disposals         = assets removed (cost + acc dep removed)
//   Depreciation      = current year policy dep charge
//   Closing balance   = computed

describe('aggregatePpeMovements', () => {
  const priorYearCE: AssetPriorYearSnapshot = {
    assetId: 'a1',
    ias16Group: 'CE',
    cost: 120_000,
    accDep: 40_000,       // prior year closing acc dep
    carryingAmount: 80_000,
  };

  const currentYearCE: AssetCurrentYearMovement = {
    assetId: 'a1',
    ias16Group: 'CE',
    additions: 0,          // no new purchase in year
    disposalCost: 0,
    disposalAccDep: 0,
    depreciationCharge: 24_000,  // 2 000 × 12 months
  };

  it('returns one group per ias16_group code', () => {
    const groups = aggregatePpeMovements([priorYearCE], [currentYearCE]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ias16Group).toBe('CE');
  });

  it('calculates opening carrying amount from prior year snapshot', () => {
    const groups = aggregatePpeMovements([priorYearCE], [currentYearCE]);
    expect(groups[0].openingCost).toBe(120_000);
    expect(groups[0].openingAccDep).toBe(40_000);
    expect(groups[0].openingCarryingAmount).toBe(80_000);
  });

  it('adds depreciation charge to accumulate closing acc dep', () => {
    const groups = aggregatePpeMovements([priorYearCE], [currentYearCE]);
    // closingAccDep = openingAccDep + depreciationCharge = 40 000 + 24 000 = 64 000
    expect(groups[0].closingAccDep).toBe(64_000);
  });

  it('calculates correct closing carrying amount', () => {
    const groups = aggregatePpeMovements([priorYearCE], [currentYearCE]);
    // closingCA = openingCost + additions − disposalCost − closingAccDep
    // = 120 000 + 0 − 0 − 64 000 = 56 000
    expect(groups[0].closingCarryingAmount).toBe(56_000);
    expect(groups[0].closingCost).toBe(120_000);
  });

  it('includes additions in closing cost', () => {
    const withAddition: AssetCurrentYearMovement = {
      ...currentYearCE,
      additions: 50_000, // new asset bought in year
    };
    const groups = aggregatePpeMovements([priorYearCE], [withAddition]);
    expect(groups[0].additions).toBe(50_000);
    expect(groups[0].closingCost).toBe(170_000);  // 120k + 50k
  });

  it('removes disposal cost and acc dep on disposal', () => {
    const withDisposal: AssetCurrentYearMovement = {
      ...currentYearCE,
      disposalCost: 30_000,
      disposalAccDep: 25_000, // acc dep removed on disposal
    };
    const groups = aggregatePpeMovements([priorYearCE], [withDisposal]);
    expect(groups[0].disposalsCost).toBe(30_000);
    expect(groups[0].disposalsAccDep).toBe(25_000);
    expect(groups[0].closingCost).toBe(90_000);   // 120k − 30k
  });

  it('aggregates multiple assets in the same IAS 16 group', () => {
    const prior2: AssetPriorYearSnapshot = {
      assetId: 'a2', ias16Group: 'CE',
      cost: 60_000, accDep: 20_000, carryingAmount: 40_000,
    };
    const current2: AssetCurrentYearMovement = {
      assetId: 'a2', ias16Group: 'CE',
      additions: 0, disposalCost: 0, disposalAccDep: 0,
      depreciationCharge: 10_000,
    };
    const groups = aggregatePpeMovements([priorYearCE, prior2], [currentYearCE, current2]);
    expect(groups).toHaveLength(1); // still one CE group
    expect(groups[0].openingCost).toBe(180_000); // 120k + 60k
    expect(groups[0].depreciationCharge).toBe(34_000); // 24k + 10k
  });

  it('returns multiple groups for different IAS 16 codes', () => {
    const priorMV: AssetPriorYearSnapshot = {
      assetId: 'b1', ias16Group: 'MV',
      cost: 300_000, accDep: 60_000, carryingAmount: 240_000,
    };
    const currentMV: AssetCurrentYearMovement = {
      assetId: 'b1', ias16Group: 'MV',
      additions: 0, disposalCost: 0, disposalAccDep: 0,
      depreciationCharge: 60_000,
    };
    const groups = aggregatePpeMovements(
      [priorYearCE, priorMV],
      [currentYearCE, currentMV],
    );
    expect(groups).toHaveLength(2);
    const mvGroup = groups.find(g => g.ias16Group === 'MV');
    expect(mvGroup?.openingCost).toBe(300_000);
    expect(mvGroup?.depreciationCharge).toBe(60_000);
  });

  it('handles asset with no prior year snapshot (new asset acquired in current year)', () => {
    const noprior: AssetCurrentYearMovement = {
      assetId: 'c1', ias16Group: 'FF',
      additions: 20_000, disposalCost: 0, disposalAccDep: 0,
      depreciationCharge: 2_000,
    };
    const groups = aggregatePpeMovements([], [noprior]);
    expect(groups).toHaveLength(1);
    expect(groups[0].openingCost).toBe(0);
    expect(groups[0].additions).toBe(20_000);
    expect(groups[0].closingCost).toBe(20_000);
    expect(groups[0].depreciationCharge).toBe(2_000);
  });

  it('returns totals that net correctly: closing CA = cost − acc dep', () => {
    const groups = aggregatePpeMovements([priorYearCE], [currentYearCE]);
    const g = groups[0];
    expect(g.closingCarryingAmount).toBeCloseTo(g.closingCost - g.closingAccDep, 2);
  });
});

// ─── Deferred Tax Schedule ────────────────────────────────────────────────────

describe('aggregateDeferredTax', () => {
  const rows: DeferredTaxCategoryRow[] = [
    {
      categoryCode: 'CE',
      categoryName: 'Computer Equipment',
      ias16Group: 'CE',
      totalPolicyCA: 80_000,
      totalTaxCA: 100_000,
      deferredTaxRate: 0.27,
    },
    {
      categoryCode: 'MV',
      categoryName: 'Motor Vehicles',
      ias16Group: 'MV',
      totalPolicyCA: 200_000,
      totalTaxCA: 150_000,
      deferredTaxRate: 0.27,
    },
  ];

  it('computes temporary difference per category', () => {
    const result = aggregateDeferredTax(rows);
    const ce = result.find(r => r.categoryCode === 'CE')!;
    // taxCA > policyCA → positive temp diff → liability
    expect(ce.temporaryDifference).toBe(20_000);
    expect(ce.deferredTax).toBeCloseTo(5_400, 2);
    expect(ce.isLiability).toBe(true);
  });

  it('produces deferred tax asset when policy CA > tax CA', () => {
    const result = aggregateDeferredTax(rows);
    const mv = result.find(r => r.categoryCode === 'MV')!;
    expect(mv.temporaryDifference).toBe(-50_000);
    expect(mv.deferredTax).toBeCloseTo(-13_500, 2);
    expect(mv.isLiability).toBe(false);
  });

  it('totals net deferred tax across all categories', () => {
    const result = aggregateDeferredTax(rows);
    const net = result.reduce((s, r) => s + r.deferredTax, 0);
    // 5 400 − 13 500 = −8 100
    expect(net).toBeCloseTo(-8_100, 2);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateDeferredTax([])).toEqual([]);
  });

  it('marks zero when carrying amounts are equal', () => {
    const equal: DeferredTaxCategoryRow[] = [{
      categoryCode: 'FF',
      categoryName: 'Furniture',
      ias16Group: 'FF',
      totalPolicyCA: 50_000,
      totalTaxCA: 50_000,
      deferredTaxRate: 0.27,
    }];
    const result = aggregateDeferredTax(equal);
    expect(result[0].deferredTax).toBe(0);
    expect(result[0].temporaryDifference).toBe(0);
  });
});
