/**
 * R-089: deriveSageVat never invents VAT. Pure unit tests — no DB.
 */

import { describe, it, expect } from 'vitest';
import { deriveSageVat, statedSageFigures, SAGE_VAT_NOT_STATED_NOTE } from '@/modules/accounting/services/shared/sageVatDerivation';

describe('deriveSageVat — a row with neither subtotal nor tax stated', () => {
  it('imports with zero tax and subtotal = total, flagged vatNotStated', () => {
    const result = deriveSageVat(null, null, 1150);
    expect(result).toEqual({ subtotal: 1150, taxAmount: 0, taxRate: 0, vatNotStated: true });
  });

  it('treats undefined the same as null', () => {
    const result = deriveSageVat(undefined, undefined, 1150);
    expect(result.vatNotStated).toBe(true);
    expect(result.taxAmount).toBe(0);
  });

  it('treats a stated 0 the same as absent (Sage staging convention)', () => {
    const result = deriveSageVat(0, 0, 1150);
    expect(result).toEqual({ subtotal: 1150, taxAmount: 0, taxRate: 0, vatNotStated: true });
  });

  it('never derives 15/115 of the total', () => {
    const result = deriveSageVat(null, null, 1150);
    // The old defect: subtotal = 1150 / 1.15 = 1000, taxAmount = 150
    expect(result.subtotal).not.toBeCloseTo(1000, 0);
    expect(result.taxAmount).toBe(0);
  });
});

describe('deriveSageVat — a row with only the subtotal stated', () => {
  it('computes tax by arithmetic against the total, not by rate', () => {
    const result = deriveSageVat(1000, null, 1150);
    expect(result).toEqual({ subtotal: 1000, taxAmount: 150, taxRate: 15, vatNotStated: false });
  });

  it('a zero-rated row (subtotal === total, no tax) reports no VAT invented', () => {
    const result = deriveSageVat(1000, null, 1000);
    expect(result).toEqual({ subtotal: 1000, taxAmount: 0, taxRate: 0, vatNotStated: false });
  });
});

describe('deriveSageVat — a row with only the tax amount stated', () => {
  it('computes subtotal by arithmetic against the total, not by rate', () => {
    const result = deriveSageVat(null, 150, 1150);
    expect(result).toEqual({ subtotal: 1000, taxAmount: 150, taxRate: 15, vatNotStated: false });
  });
});

describe('deriveSageVat — a row with both stated', () => {
  it('keeps both figures the source recorded, and computes the rate from them', () => {
    const result = deriveSageVat(1000, 150, 1150);
    expect(result).toEqual({ subtotal: 1000, taxAmount: 150, taxRate: 15, vatNotStated: false });
  });

  it('a non-standard rate is kept, not rounded to 15%', () => {
    const result = deriveSageVat(1000, 100, 1100);
    expect(result.taxRate).toBe(10);
    expect(result.vatNotStated).toBe(false);
  });
});

describe('deriveSageVat — a negative-total (credit-note-shaped) row', () => {
  it('keeps the rate consistent with the tax amount when only the subtotal is stated', () => {
    const result = deriveSageVat(-1000, null, -1150);
    expect(result).toEqual({ subtotal: -1000, taxAmount: -150, taxRate: 15, vatNotStated: false });
  });

  it('keeps the rate consistent with the tax amount when only the tax is stated', () => {
    const result = deriveSageVat(null, -150, -1150);
    expect(result).toEqual({ subtotal: -1000, taxAmount: -150, taxRate: 15, vatNotStated: false });
  });
});

describe('statedSageFigures — VAT the source states anywhere counts as stated', () => {
  it('prefers the staging columns', () => {
    expect(statedSageFigures('1000.00', '150.00', { Exclusive: 1, Tax: 2 }, [{ Tax: 3 }]))
      .toEqual({ subtotal: '1000.00', tax: '150.00' });
  });

  it('falls back to the raw document header', () => {
    expect(statedSageFigures(null, null, { Exclusive: 1000, Tax: 150 }, null))
      .toEqual({ subtotal: 1000, tax: 150 });
  });

  it('falls back to the sum of line tax, rounded to cents', () => {
    expect(statedSageFigures(null, null, {}, [{ Tax: 100.004 }, { Tax: 50 }, {}]))
      .toEqual({ subtotal: null, tax: 150 });
  });

  it('states nothing when every source is empty or zero', () => {
    expect(statedSageFigures(null, 0, { Tax: 0 }, [{ Tax: 0 }])).toEqual({ subtotal: null, tax: null });
  });
});

describe('SAGE_VAT_NOT_STATED_NOTE', () => {
  it('is a non-empty reviewer-facing string', () => {
    expect(SAGE_VAT_NOT_STATED_NOTE.length).toBeGreaterThan(10);
    expect(SAGE_VAT_NOT_STATED_NOTE.toLowerCase()).toContain('review');
  });
});
