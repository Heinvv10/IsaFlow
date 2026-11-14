/**
 * A directive create body (wave 5 DR, round 1): every type's limits, the IRP3(b)/(c) rules, and the window a directive is
 * in force for (G21 (2027) Rev 1 p. 15: "only valid for the tax year or period stated thereon"). Code 3230 rules: BRS
 * V25.3.0 p. 41 ("For fixed PAYE rate/amount directives, ONLY the directive number MUST be completed"; AN15).
 */
import { describe, expect, it } from 'vitest';
import {
  directiveBodyProblem as common, regularPayDirectiveBodyProblem as problem,
} from '@/modules/accounting/services/payroll/taxDirectiveRegularPayBody';
import { directiveEndsOn } from '@/modules/accounting/services/payroll/taxDirectiveOverlap';
import { regularDirectiveFieldLines } from '@/modules/accounting/services/payroll/easyFileRegularDirectives';

const pct = { directive_type: 'fixed_percentage' as const, tax_rate: 0.2, effective_date: '2026-03-01', directive_number: '1234567' };
const amt = { directive_type: 'fixed_amount' as const, tax_amount: 2500, effective_date: '2026-03-01', directive_number: '7654321' };

describe('regularPayDirectiveBodyProblem', () => {
  it('accepts a percentage with a rate, an amount with a tax amount, amount absent or 0', () => {
    expect([problem(pct), problem(amt), problem({ ...pct, amount: 0 }), problem({ ...amt, amount: '0', expiry_date: '2026-08-31' })]).toEqual([null, null, null, null]);
  });
  it('refuses a gross amount: SARS states a rate or a tax amount', () => {
    expect(problem({ ...pct, amount: 30000 })).toMatch(/amount is not used/);
  });
  it('a percentage: above 0 and at most 1 (0 and 1.0001 refused, 1 allowed), no tax_amount', () => {
    expect(problem({ ...pct, tax_rate: 0 })).toMatch(/above 0/);
    expect(problem({ ...pct, tax_rate: 1.0001 })).toMatch(/above 0 and at most 1/);
    expect(problem({ ...pct, tax_rate: 1 })).toBeNull();
    expect(problem({ ...pct, tax_rate: undefined })).toMatch(/tax_rate is required/);
    expect(problem({ ...pct, tax_rate: [0.2] })).toMatch(/tax_rate is required/);
    expect(problem({ ...pct, tax_amount: 100 })).toMatch(/tax_amount is for a fixed-amount/);
  });
  it('an amount: above R0 in rands and cents, no rate', () => {
    expect(problem({ ...amt, tax_amount: 0 })).toMatch(/above R0/);
    expect(problem({ ...amt, tax_amount: -1 })).toMatch(/above R0/);
    expect(problem({ ...amt, tax_amount: 2500.005 })).toMatch(/rands and cents/);
    expect(problem({ ...amt, tax_amount: undefined })).toMatch(/tax_amount is required/);
    expect(problem({ ...amt, tax_rate: 0.2 })).toMatch(/tax_rate is for a fixed-percentage/);
  });
  it('the directive number is required, AN15 and not zeros (BRS V25.3.0 p. 41)', () => {
    for (const n of [undefined, '', '000000', '1234567890123456', '12-34']) expect(problem({ ...pct, directive_number: n })).toMatch(/directive_number is required/);
    expect(problem({ ...pct, directive_number: 'A1B2C3D4E5F6G7H' })).toBeNull();
  });
  it('dates: real YYYY-MM-DD, expiry on or after effective', () => {
    expect(problem({ ...pct, effective_date: '2026-02-30' })).toMatch(/effective_date/);
    expect(problem({ ...pct, effective_date: undefined })).toMatch(/effective_date/);
    expect(problem({ ...pct, expiry_date: '2026-02-28' })).toMatch(/on or after/);
    expect(problem({ ...pct, expiry_date: '2026-03-01' })).toBeNull();
  });
});

describe('the expiry ceiling: the end of the tax year after the one it starts in (Hein, #1266)', () => {
  it('03-01 start: 2028-02-29 (a leap year) accepted, 2028-03-01 refused naming the limit; a 02-01 start ends 2027-02-28 at most', () => {
    expect(problem({ ...pct, expiry_date: '2028-02-29' })).toBeNull();
    expect(problem({ ...pct, expiry_date: '2028-03-01' })).toMatch(/past 2028-02-29, the end of the tax year after the one the directive starts in/);
    expect(problem({ ...pct, effective_date: '2026-02-01', expiry_date: '2026-12-31' })).toBeNull();
    expect(problem({ ...pct, effective_date: '2026-02-01', expiry_date: '2027-02-28' })).toBeNull();
    expect(problem({ ...pct, effective_date: '2026-02-01', expiry_date: '2027-03-01' })).toMatch(/past 2027-02-28/);
    expect(problem({ ...amt, expiry_date: '2028-03-01' })).toMatch(/past 2028-02-29/);
  });
});

describe('directiveBodyProblem: every type', () => {
  it('lengths: directive_number 50, sars_reference 100', () => {
    expect(common({ directive_number: 'x'.repeat(51) })).toMatch(/at most 50/);
    expect(common({ sars_reference: 'x'.repeat(101) })).toMatch(/at most 100/);
    expect(common({ directive_number: 'x'.repeat(50), sars_reference: 'x'.repeat(100) })).toBeNull();
  });
  it('dates: "" and outside 2000-2100 are refused (a 400, not a DATE-cast 500)', () => {
    for (const d of ['', '1999-12-31', '2101-01-01', '2026-13-01']) {
      expect(common({ expiry_date: d })).toMatch(/expiry_date must be a date/);
      expect(common({ effective_date: d })).toMatch(/effective_date must be a date/);
    }
    expect(common({ effective_date: '2000-01-01', expiry_date: '2100-12-31' })).toBeNull();
  });
  it('tax_rate: 0..1 with at most 4 decimals, never rounded silently', () => {
    expect(common({ tax_rate: 0.18255 })).toMatch(/at most 4 decimals/);
    expect(common({ tax_rate: '0.1825' })).toBeNull();
    expect(common({ tax_rate: 1e-7 })).toMatch(/at most 4 decimals/);
    expect(common({ tax_rate: 1.0001 })).toMatch(/between 0 and 1/);
    expect([common({ tax_rate: 0 }), common({ tax_rate: 1 })]).toEqual([null, null]);
  });
});

describe('directiveEndsOn: its expiry, else the last day of its tax year (end of February)', () => {
  it.each([
    ['2026-03-01', null, '2027-02-28'],
    ['2027-01-15', null, '2027-02-28'],
    ['2027-02-15', null, '2027-02-28'],
    ['2027-03-01', null, '2028-02-29'],
    ['2028-01-10', null, '2028-02-29'],
    ['2026-06-01', '2026-08-31', '2026-08-31'],
  ])('%s, expiry %s -> %s', (effective, expiry, want) => {
    expect(directiveEndsOn(effective, expiry)).toBe(want);
  });
});

describe('code 3230 for a regular-pay directive on the certificate (BRS V25.3.0 p. 41-42)', () => {
  it('one 3230 per number, nothing else', () => {
    expect(regularDirectiveFieldLines(['1234567', 'AB12'], 0, 'A B')).toEqual(['3230,"1234567"', '3230,"AB12"']);
    expect(regularDirectiveFieldLines(undefined, 2, 'A B')).toEqual([]);
  });
  it('a number the certificate cannot carry, or more than 5 directives in all: refused', () => {
    expect(() => regularDirectiveFieldLines([''], 0, 'A B')).toThrow(/cannot go on the certificate/);
    expect(() => regularDirectiveFieldLines(['0000'], 0, 'A B')).toThrow(/cannot go on the certificate/);
    expect(() => regularDirectiveFieldLines(['1', '2', '3'], 3, 'A B')).toThrow(/at most 5/);
    expect(regularDirectiveFieldLines(['1', '2', '3'], 2, 'A B')).toHaveLength(3);
  });
});
