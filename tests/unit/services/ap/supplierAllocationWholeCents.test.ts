/**
 * The pure halves of the whole-cent defence for supplier allocations:
 * `toCents` rounds the way NUMERIC(15,2) does (decimal text, half away from
 * zero), and `assertAllocationShape` refuses an amount that is not whole cents.
 * The database outcome is pinned in tests/integration/ap-allocation-whole-cents.int.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { toCents } from '@/modules/accounting/services/ap/billAllocatable';
import { round2 } from '@/modules/accounting/services/ap/supplierAllocationLines';
import { assertAllocationShape } from '@/modules/accounting/services/ap/supplierAllocationShape';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

describe('toCents', () => {
  it.each([
    [1.005, 101], [0.005, 1], [10.005, 1001], [100.0049, 10000], [1.004, 100], [2.675, 268],
    [0, 0], [100, 10000], [282543.34, 28254334], [0.1 + 0.2, 30], [99.99, 9999],
  ])('%s is %s cents, as the column stores it', (n, cents) => {
    expect(toCents(n)).toBe(cents);
  });

  it('rounds a negative half away from zero, as Postgres does', () => {
    expect(toCents(-1.005)).toBe(-101);
    expect(toCents(-0.004)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('throws on %s rather than return NaN', (n) => {
    expect(() => toCents(n)).toThrow(RangeError);
  });

  it('falls back to the float round for an exponential rendering', () => {
    expect(toCents(1e-7)).toBe(0);
    expect(toCents(1e21)).toBe(1e23);
  });
});

describe('assertAllocationShape', () => {
  const A = '44444444-4444-4444-8444-44444444444a';
  const B = '44444444-4444-4444-8444-44444444444b';
  const C = '00000000-0000-0000-0000-000000000001'; // seeded, non-v4: must stay valid
  const alloc = (amount: number, invoiceId = A) => ({ invoiceId, amount });

  it('accepts whole-cent amounts', () => {
    expect(() => assertAllocationShape([alloc(0.01), alloc(282543.34, B), alloc(99.99, C)])).not.toThrow();
  });

  it.each([1.005, 0.005, 10.0049, 0.001])('refuses %s as not a whole number of cents', (amount) => {
    expect(() => assertAllocationShape([alloc(amount)])).toThrow(SupplierPaymentRefusal);
    expect(() => assertAllocationShape([alloc(amount)])).toThrow(/whole number of cents/);
  });

  it('still refuses empty, non-positive and duplicate requests', () => {
    expect(() => assertAllocationShape([])).toThrow(/at least one allocation/);
    expect(() => assertAllocationShape([alloc(0)])).toThrow(/positive number/);
    expect(() => assertAllocationShape([alloc(1), alloc(2)])).toThrow(/more than once/);
  });
});

describe('round2 (supplier allocations)', () => {
  it.each([[1.005, 1.01], [0.005, 0.01], [2.675, 2.68], [-1.005, -1.01], [99.99, 99.99], [0.1 + 0.2, 0.3], [0, 0]])(
    'round2(%s) is %s, agreeing with toCents', (n, expected) => {
      expect(round2(n)).toBe(expected);
      expect(round2(n)).toBe(toCents(n) / 100);
    });

  it('throws on a non-finite figure rather than let NaN through', () => {
    expect(() => round2(Number.NaN)).toThrow(RangeError);
  });
});
