/**
 * The create body of an IRP3(b) fixed-percentage / IRP3(c) fixed-amount directive (wave 5 DR), and the window a directive
 * is in force for (G21 (2027) Rev 1 p. 15: "only valid for the tax year or period stated thereon").
 */
import { describe, expect, it } from 'vitest';
import { regularPayDirectiveBodyProblem as problem } from '@/modules/accounting/services/payroll/taxDirectiveRegularPayBody';
import { directiveEndsOn } from '@/modules/accounting/services/payroll/taxDirectiveOverlap';

const pct = { directive_type: 'fixed_percentage' as const, tax_rate: 0.2, effective_date: '2026-03-01' };
const amt = { directive_type: 'fixed_amount' as const, tax_amount: 2500, effective_date: '2026-03-01' };

describe('regularPayDirectiveBodyProblem', () => {
  it('accepts a percentage with a rate, an amount with a tax amount, amount absent or 0', () => {
    expect([problem(pct), problem(amt), problem({ ...pct, amount: 0 }), problem({ ...amt, amount: '0', expiry_date: '2026-08-31' })]).toEqual([null, null, null, null]);
  });
  it('refuses a gross amount: SARS states a rate or a tax amount', () => {
    expect(problem({ ...pct, amount: 30000 })).toMatch(/amount is not used/);
  });
  it('a percentage needs a fraction 0..1 and no tax_amount', () => {
    expect(problem({ ...pct, tax_rate: undefined })).toMatch(/tax_rate is required/);
    expect(problem({ ...pct, tax_rate: 20 })).toMatch(/fraction between 0 and 1/);
    expect(problem({ ...pct, tax_rate: [0.2] })).toMatch(/tax_rate is required/);
    expect(problem({ ...pct, tax_amount: 100 })).toMatch(/tax_amount is for a fixed-amount/);
  });
  it('an amount needs tax_amount >= 0 and no rate', () => {
    expect(problem({ ...amt, tax_amount: undefined })).toMatch(/tax_amount is required/);
    expect(problem({ ...amt, tax_amount: -1 })).toMatch(/tax_amount is required/);
    expect(problem({ ...amt, tax_rate: 0.2 })).toMatch(/tax_rate is for a fixed-percentage/);
    expect(problem({ ...amt, tax_amount: 0 })).toBeNull();
  });
  it('dates: real YYYY-MM-DD, expiry on or after effective', () => {
    expect(problem({ ...pct, effective_date: '2026-02-30' })).toMatch(/effective_date/);
    expect(problem({ ...pct, effective_date: undefined })).toMatch(/effective_date/);
    expect(problem({ ...pct, expiry_date: '2026-13-01' })).toMatch(/expiry_date must be a date/);
    expect(problem({ ...pct, expiry_date: '2026-02-28' })).toMatch(/on or after/);
    expect(problem({ ...pct, expiry_date: '2026-03-01' })).toBeNull();
  });
});

describe('directiveEndsOn: its expiry, else the last day of its tax year (end of February)', () => {
  it.each([
    ['2026-03-01', null, '2027-02-28'],
    ['2027-02-15', null, '2027-02-28'],
    ['2027-03-01', null, '2028-02-29'],
    ['2026-06-01', '2026-08-31', '2026-08-31'],
  ])('%s, expiry %s -> %s', (effective, expiry, want) => {
    expect(directiveEndsOn(effective, expiry)).toBe(want);
  });
});
