/**
 * toFunctional — the TypeScript twin of public.fx_functional (migration 871):
 * ROUND(amount * rate, 2), half away from zero, in exact decimal. Float
 * arithmetic (`Math.round(x * r * 100) / 100`) is what it replaces, and the
 * cases below are the ones float gets wrong. Parity with Postgres itself is
 * proved on a real database in tests/integration/fx-pr0-refusals.int.test.ts.
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
    expect(toFunctional(1e-7, 1e7)).toBe(1);
    expect(toFunctional(2e3, 0.5)).toBe(1000);
  });
});
