import { describe, it, expect } from 'vitest';
import {
  calculateStraightLine, calculateReducingBalance, calculateSumOfYears,
  calculateDepreciation, type DepreciationInput,
} from '@/modules/accounting/services/assetService';

describe('Straight-Line Depreciation', () => {
  it('calculates monthly depreciation correctly', () => {
    const result = calculateStraightLine({ cost: 120000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 0 });
    expect(result.monthlyAmount).toBe(2000);
    expect(result.annualAmount).toBe(24000);
  });
  it('accounts for salvage value', () => {
    const result = calculateStraightLine({ cost: 100000, salvageValue: 10000, usefulLifeYears: 5, monthsElapsed: 0 });
    expect(result.monthlyAmount).toBe(1500);
  });
  it('returns zero when fully depreciated', () => {
    const result = calculateStraightLine({ cost: 60000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 60 });
    expect(result.monthlyAmount).toBe(0);
  });
  it('caps depreciation at remaining depreciable amount', () => {
    const result = calculateStraightLine({ cost: 60000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 59, accumulatedDepreciation: 59000 });
    expect(result.monthlyAmount).toBe(1000);
  });
  it('handles zero useful life gracefully', () => {
    expect(calculateStraightLine({ cost: 10000, salvageValue: 0, usefulLifeYears: 0, monthsElapsed: 0 }).monthlyAmount).toBe(0);
  });
  it('handles cost equal to salvage value', () => {
    expect(calculateStraightLine({ cost: 10000, salvageValue: 10000, usefulLifeYears: 5, monthsElapsed: 0 }).monthlyAmount).toBe(0);
  });
});

describe('Reducing Balance Depreciation', () => {
  it('calculates first month correctly', () => {
    const result = calculateReducingBalance({ cost: 100000, salvageValue: 10000, usefulLifeYears: 5, monthsElapsed: 0 });
    expect(result.monthlyAmount).toBeCloseTo(3333.33, 0);
  });
  it('reduces as book value decreases', () => {
    const m1 = calculateReducingBalance({ cost: 100000, salvageValue: 10000, usefulLifeYears: 5, monthsElapsed: 0 });
    const m2 = calculateReducingBalance({ cost: 100000, salvageValue: 10000, usefulLifeYears: 5, monthsElapsed: 1, accumulatedDepreciation: m1.monthlyAmount });
    expect(m2.monthlyAmount).toBeLessThan(m1.monthlyAmount);
  });
  it('does not depreciate below salvage value', () => {
    const result = calculateReducingBalance({ cost: 100000, salvageValue: 10000, usefulLifeYears: 5, monthsElapsed: 120, accumulatedDepreciation: 89500 });
    expect(result.monthlyAmount).toBeLessThanOrEqual(500);
  });
});

describe('Sum-of-Years Digits Depreciation', () => {
  it('calculates first year correctly', () => {
    const result = calculateSumOfYears({ cost: 150000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 0 });
    expect(result.monthlyAmount).toBeCloseTo(4166.67, 0);
  });
  it('decreases each year', () => {
    const y1 = calculateSumOfYears({ cost: 150000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 0 });
    const y2 = calculateSumOfYears({ cost: 150000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 12 });
    expect(y2.monthlyAmount).toBeLessThan(y1.monthlyAmount);
  });
  it('returns zero after useful life exhausted', () => {
    expect(calculateSumOfYears({ cost: 150000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 60 }).monthlyAmount).toBe(0);
  });
});

describe('SARS Wear-and-Tear Integration', () => {
  it('applies SARS rate for computers (3 years)', () => {
    const r = calculateDepreciation({ cost: 30000, salvageValue: 0, usefulLifeYears: 3, monthsElapsed: 0, method: 'straight_line', sarsCategory: 'computers' });
    expect(r.monthlyAmount).toBeCloseTo(833.33, 0);
    expect(r.annualRate).toBeCloseTo(33.33, 0);
  });
  it('applies SARS rate for motor vehicles (5 years)', () => {
    const r = calculateDepreciation({ cost: 500000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 0, method: 'straight_line', sarsCategory: 'motor_vehicles' });
    expect(r.monthlyAmount).toBeCloseTo(8333.33, 0);
    expect(r.annualRate).toBeCloseTo(20, 0);
  });
  it('applies SARS rate for furniture (6 years)', () => {
    const r = calculateDepreciation({ cost: 36000, salvageValue: 0, usefulLifeYears: 6, monthsElapsed: 0, method: 'straight_line', sarsCategory: 'furniture' });
    expect(r.monthlyAmount).toBe(500);
    expect(r.annualRate).toBeCloseTo(16.67, 0);
  });
  it('applies SARS rate for manufacturing equipment (4 years)', () => {
    const r = calculateDepreciation({ cost: 1000000, salvageValue: 0, usefulLifeYears: 4, monthsElapsed: 0, method: 'straight_line', sarsCategory: 'manufacturing_equipment' });
    expect(r.annualRate).toBeCloseTo(25, 0);
  });
});

describe('calculateDepreciation dispatcher', () => {
  const base: DepreciationInput = { cost: 120000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 0, method: 'straight_line' };
  it('routes to straight-line', () => { const r = calculateDepreciation({ ...base, method: 'straight_line' }); expect(r.method).toBe('straight_line'); expect(r.monthlyAmount).toBe(2000); });
  it('routes to reducing balance', () => { const r = calculateDepreciation({ ...base, method: 'reducing_balance' }); expect(r.method).toBe('reducing_balance'); expect(r.monthlyAmount).toBeGreaterThan(0); });
  it('routes to sum-of-years', () => { const r = calculateDepreciation({ ...base, method: 'sum_of_years' }); expect(r.method).toBe('sum_of_years'); expect(r.monthlyAmount).toBeGreaterThan(0); });
  it('defaults to straight-line for unknown method', () => { expect(calculateDepreciation({ ...base, method: 'unknown' as any }).method).toBe('straight_line'); });
  it('result includes all required fields', () => {
    const r = calculateDepreciation(base);
    expect(r).toHaveProperty('monthlyAmount'); expect(r).toHaveProperty('annualAmount');
    expect(r).toHaveProperty('annualRate'); expect(r).toHaveProperty('method'); expect(r).toHaveProperty('remainingMonths');
  });
});

describe('Tax vs Book Depreciation', () => {
  it('can calculate both tax and book depreciation', () => {
    const bookDep = calculateDepreciation({ cost: 100000, salvageValue: 10000, usefulLifeYears: 10, monthsElapsed: 0, method: 'straight_line' });
    const taxDep = calculateDepreciation({ cost: 100000, salvageValue: 0, usefulLifeYears: 6, monthsElapsed: 0, method: 'straight_line', sarsCategory: 'furniture' });
    expect(taxDep.monthlyAmount).toBeGreaterThan(bookDep.monthlyAmount);
  });
});
