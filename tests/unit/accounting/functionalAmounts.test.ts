/**
 * toFunctional — the TypeScript twin of the SQL callers'
 * public.fx_functional(amount::NUMERIC(15,2), rate::NUMERIC(18,6)) (migration
 * 871): the inputs rounded as those casts round them, then ROUND(amount *
 * rate, 2), all half away from zero, in exact decimal. Float arithmetic
 * (`Math.round(x * r * 100) / 100`) is what it replaces, and the cases below
 * are the ones float gets wrong. Parity with Postgres itself is proved on a
 * real database in tests/integration/fx-pr0-db.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { toFunctional } from '@/modules/accounting/services/shared/functionalAmounts';

describe('toFunctional', () => {
  it('converts at the rate and rounds to cents', () => {
    expect(toFunctional(10000, 18.5)).toBe(185000);
    expect(toFunctional('1500.00', '18.500000')).toBe(27750);
    expect(toFunctional(100, 18.333)).toBe(1833.3);
    expect(toFunctional(1, 18.333)).toBe(18.33);
    expect(toFunctional(5, 18.333)).toBe(91.67);
  });

  it('rounds a half cent away from zero, where float rounds it down', () => {
    // 1.005 * 1 * 100 is 100.49999999999999 in float, so Math.round gives 1.00.
    expect(Math.round(1.005 * 1 * 100) / 100).toBe(1);
    expect(toFunctional(1.005, 1)).toBe(1.01);
    expect(toFunctional('1.25', '0.5')).toBe(0.63);
    expect(toFunctional(-1.25, 0.5)).toBe(-0.63);
    expect(toFunctional('0.125', 1)).toBe(0.13);
    expect(toFunctional('-0.125', 1)).toBe(-0.13);
  });

  it('is exact where float drifts', () => {
    // 4.35 * 100 is 434.99999999999994 in float.
    expect(toFunctional(4.35, 100)).toBe(435);
    expect(toFunctional(0.1, 3)).toBe(0.3);
    expect(toFunctional('9999999999999.99', '1')).toBe(9999999999999.99);
  });

  it('treats zero and a rate of 1 as identity', () => {
    expect(toFunctional(0, 18.5)).toBe(0);
    expect(toFunctional(1234.56, 1)).toBe(1234.56);
  });

  it('refuses what is not a finite decimal', () => {
    expect(() => toFunctional(Number.NaN, 1)).toThrow(/not a finite decimal/);
    expect(() => toFunctional(1, Number.POSITIVE_INFINITY)).toThrow(/not a finite decimal/);
    expect(() => toFunctional('12abc', 1)).toThrow(/not a finite decimal/);
    expect(() => toFunctional('', 1)).toThrow(/not a finite decimal/);
  });

  it('reads exponent notation exactly', () => {
    expect(toFunctional(2e3, 0.5)).toBe(1000);
    expect(toFunctional(1e3, 1.5e-1)).toBe(150);
  });

  it('rounds the amount to cents and the rate to six places first, as the NUMERIC casts do', () => {
    // 10.005 → 10.01 (NUMERIC(15,2)), then * 2: 20.02, where the unrounded product is 20.01.
    expect(toFunctional('10.005', '2')).toBe(20.02);
    expect(toFunctional('-10.005', '2')).toBe(-20.02);
    // 1.00000025 → 1.000000 (NUMERIC(18,6)): 20 000.00, where the unrounded product is 20 000.005 → 20 000.01.
    expect(toFunctional('20000', '1.00000025')).toBe(20000);
    // 1.0000005 → 1.000001: 20 000.02, where the unrounded product is 20 000.01.
    expect(toFunctional('20000', '1.0000005')).toBe(20000.02);
    // A sub-cent amount is nothing, as NUMERIC(15,2) makes it.
    expect(toFunctional(1e-7, 1e7)).toBe(0);
  });
});
