import { describe, it, expect } from 'vitest';
import { deriveAmountPaid } from '../../../scripts/lib/amountPaid';

// CHECK customer_invoices_amount_paid_within_total: amount_paid <= GREATEST(total_amount, 0)
describe('deriveAmountPaid', () => {
  it('partial payment is stored as-is', () => {
    expect(deriveAmountPaid(1000, 400)).toEqual({ amountPaid: 600, clamped: false, paid: false });
  });
  it('exactly paid', () => {
    expect(deriveAmountPaid(1000, 0)).toEqual({ amountPaid: 1000, clamped: false, paid: true });
  });
  it('unpaid', () => {
    expect(deriveAmountPaid(1000, 1000)).toEqual({ amountPaid: 0, clamped: false, paid: false });
  });
  it('over-paid (AmountDue < 0) clamps to total and is paid', () => {
    expect(deriveAmountPaid(1000, -50)).toEqual({ amountPaid: 1000, clamped: true, paid: true });
  });
  it('negative total clamps the upper bound to 0', () => {
    expect(deriveAmountPaid(-100, -100)).toEqual({ amountPaid: 0, clamped: false, paid: false });
    expect(deriveAmountPaid(-100, -300)).toEqual({ amountPaid: 0, clamped: true, paid: true });
  });
  it('negative total with nothing due keeps the (check-legal) negative paid value', () => {
    expect(deriveAmountPaid(-100, 0)).toEqual({ amountPaid: -100, clamped: false, paid: true });
  });
  it('zero total', () => {
    expect(deriveAmountPaid(0, 0)).toEqual({ amountPaid: 0, clamped: false, paid: true });
    expect(deriveAmountPaid(0, -20)).toEqual({ amountPaid: 0, clamped: true, paid: true });
  });
  it('never exceeds GREATEST(total, 0)', () => {
    for (const [t, d] of [[500, -1], [0, -5], [-5, -10], [99.99, 0.01], [10, 20]] as const) {
      expect(deriveAmountPaid(t, d).amountPaid).toBeLessThanOrEqual(Math.max(t, 0));
    }
  });
  it('missing AmountDue is not treated as paid', () => {
    expect(deriveAmountPaid(1000, undefined)).toEqual({ amountPaid: 1000, clamped: false, paid: false });
    expect(deriveAmountPaid(1000, null)).toEqual({ amountPaid: 1000, clamped: false, paid: false });
  });
  it('rounds the ceiling to cents (total with more than 2 decimals)', () => {
    expect(deriveAmountPaid(100.006, -1)).toEqual({ amountPaid: 100.01, clamped: true, paid: true });
    expect(deriveAmountPaid(100.004, -1)).toEqual({ amountPaid: 100, clamped: true, paid: true });
  });
  it('throws on non-finite input', () => {
    expect(() => deriveAmountPaid(NaN, 0)).toThrow(/non-finite/);
    expect(() => deriveAmountPaid(100, NaN)).toThrow(/non-finite/);
    expect(() => deriveAmountPaid(Infinity, 0)).toThrow(/non-finite/);
  });
});
