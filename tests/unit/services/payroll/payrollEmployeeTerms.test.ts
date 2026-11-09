/**
 * Employee work terms (mig 967): what create and PATCH accept, the director prompt, and the history diff.
 * Limits follow the migration's CHECKs: hours a week 0 < h <= 168, a day 0 < h <= 24, rates >= 0 to the cent,
 * occupation <= 100 characters (BCEA s33(1)(b) is the payslip's reason for it).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMS, directorStatusPrompt, EMPLOYEE_TERM_LOG_KEYS, movedTerms, movesPricedTerm, termsFromRow, termsOfCreate, termsOfPatch,
} from '@/modules/accounting/services/payroll/payrollEmployeeTerms';

const refuse = (m: string) => new Error(m);

describe('termsOfCreate', () => {
  it('defaults to employee / monthly with nothing else', () => {
    expect(termsOfCreate({}, refuse)).toEqual({
      taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: null, hoursPerDay: null, hourlyRate: null, dailyRate: null, occupation: null,
    });
  });

  it('takes every term and trims the occupation', () => {
    expect(termsOfCreate({
      taxStatus: 'independent_contractor', payBasis: 'daily', hoursPerWeek: 45, hoursPerDay: 9, hourlyRate: 120.5, dailyRate: 900, occupation: '  Driver ',
    }, refuse)).toEqual({
      taxStatus: 'independent_contractor', payBasis: 'daily', hoursPerWeek: 45, hoursPerDay: 9, hourlyRate: 120.5, dailyRate: 900, occupation: 'Driver',
    });
  });

  it.each([
    [{ taxStatus: 'boss' }, /taxStatus/], [{ payBasis: 'weekly' }, /payBasis/],
    [{ hoursPerWeek: 169 }, /hoursPerWeek/], [{ hoursPerWeek: 0 }, /hoursPerWeek/], [{ hoursPerWeek: '40' }, /hoursPerWeek/],
    [{ hoursPerDay: 24.5 }, /hoursPerDay/], [{ hourlyRate: -0.01 }, /hourlyRate/], [{ dailyRate: 1.005 }, /dailyRate/],
    [{ dailyRate: Number.NaN }, /dailyRate/], [{ hourlyRate: 1e12 }, /hourlyRate/], [{ occupation: 'x'.repeat(101) }, /occupation/],
    [{ occupation: 42 }, /occupation/],
  ])('refuses %j', (body, message) => {
    expect(() => termsOfCreate(body, refuse)).toThrow(message);
  });

  it('accepts the limits themselves', () => {
    expect(termsOfCreate({ hoursPerWeek: 168, hoursPerDay: 24, hourlyRate: 0, occupation: 'x'.repeat(100) }, refuse)).toMatchObject({
      hoursPerWeek: 168, hoursPerDay: 24, hourlyRate: 0,
    });
  });
});

describe('termsOfPatch', () => {
  it('returns only the keys present; null or blank clears an optional term', () => {
    expect(termsOfPatch({ firstName: 'x' }, refuse)).toEqual({});
    expect(termsOfPatch({ hoursPerWeek: null, occupation: '', dailyRate: 800 }, refuse)).toEqual({ hoursPerWeek: null, occupation: null, dailyRate: 800 });
  });

  it('a tax status or pay basis cannot be blanked', () => {
    expect(() => termsOfPatch({ taxStatus: null }, refuse)).toThrow(/taxStatus/);
    expect(() => termsOfPatch({ payBasis: '' }, refuse)).toThrow(/payBasis/);
  });
});

describe('directorStatusPrompt', () => {
  it('asks only when the employment type is director and the tax status is not', () => {
    expect(directorStatusPrompt({ employmentType: 'director', taxStatus: 'employee' })).toBe('Set tax status to Director?');
    expect(directorStatusPrompt({ employmentType: 'director', taxStatus: 'director' })).toBeNull();
    expect(directorStatusPrompt({ employmentType: 'permanent', taxStatus: 'employee' })).toBeNull();
    expect(directorStatusPrompt({ employmentType: 'director', taxStatus: 'independent_contractor' })).toBeNull();
  });
});

describe('termsFromRow and movedTerms', () => {
  it('reads pg NUMERIC text as numbers', () => {
    expect(termsFromRow({ tax_status: 'director', pay_basis: 'hourly', hours_per_week: '40.00', hourly_rate: '185.50' })).toMatchObject({
      taxStatus: 'director', payBasis: 'hourly', hoursPerWeek: 40, hourlyRate: 185.5, dailyRate: null, occupation: null,
    });
    expect(termsFromRow({}).taxStatus).toBe('employee'); // a fixture row without the column
  });

  it('lists only the terms that moved, by column name', () => {
    const before = termsFromRow({ tax_status: 'employee', pay_basis: 'monthly', hours_per_week: '40.00' });
    const after = termsFromRow({ tax_status: 'director', pay_basis: 'monthly', hours_per_week: '40' });
    expect(movedTerms(before, after)).toEqual([{ field: 'tax_status', oldValue: 'employee', newValue: 'director' }]);
  });
});

describe('cross-column rules (the migration CHECKs, refused here first)', () => {
  it('an hourly employee needs an hourly rate above 0, a daily one a daily rate above 0', () => {
    expect(() => termsOfCreate({ payBasis: 'hourly' }, refuse)).toThrow(/hourlyRate/);
    expect(() => termsOfCreate({ payBasis: 'hourly', hourlyRate: 0 }, refuse)).toThrow(/hourlyRate/);
    expect(() => termsOfCreate({ payBasis: 'daily', hourlyRate: 100 }, refuse)).toThrow(/dailyRate/);
    expect(termsOfCreate({ payBasis: 'hourly', hourlyRate: 100 }, refuse).payBasis).toBe('hourly');
    expect(termsOfCreate({ payBasis: 'daily', dailyRate: 900 }, refuse).payBasis).toBe('daily');
  });

  it('a day cannot be longer than the week; a monthly employee may carry hours', () => {
    expect(() => termsOfCreate({ hoursPerWeek: 8, hoursPerDay: 9 }, refuse)).toThrow(/hoursPerDay/);
    expect(termsOfCreate({ hoursPerWeek: 40, hoursPerDay: 8 }, refuse)).toMatchObject({ payBasis: 'monthly', hoursPerWeek: 40 });
  });

  it('a patch is judged as the terms would stand after it', () => {
    const hourly = { ...DEFAULT_TERMS, payBasis: 'hourly' as const, hourlyRate: 120 };
    expect(() => termsOfPatch({ hourlyRate: null }, refuse, hourly)).toThrow(/hourlyRate/);
    expect(() => termsOfPatch({ payBasis: 'daily' }, refuse, hourly)).toThrow(/dailyRate/);
    expect(() => termsOfPatch({ hoursPerDay: 10 }, refuse, { ...DEFAULT_TERMS, hoursPerWeek: 8 })).toThrow(/hoursPerDay/);
    expect(termsOfPatch({ occupation: 'x' }, refuse, hourly)).toEqual({ occupation: 'x' });
  });
});

describe('occupation', () => {
  it('strips control characters', () => {
    expect(termsOfCreate({ occupation: 'Wel\u0000der\n\u001b[31m' }, refuse).occupation).toBe('Welder[31m');
  });
});

describe('priced terms', () => {
  it('moves only when a priced term differs from the stored one', () => {
    expect(movesPricedTerm({ occupation: 'x' }, DEFAULT_TERMS)).toBe(false);
    // Hours classify the employment (G21 p. 28), so they are priced.
    expect(movesPricedTerm({ hoursPerWeek: 40 }, DEFAULT_TERMS)).toBe(true);
    expect(movesPricedTerm({ hoursPerDay: 5 }, DEFAULT_TERMS)).toBe(true);
    expect(movesPricedTerm({ hoursPerWeek: 40 }, { ...DEFAULT_TERMS, hoursPerWeek: 40 })).toBe(false);
    expect(movesPricedTerm({ taxStatus: 'employee' }, DEFAULT_TERMS)).toBe(false);
    expect(movesPricedTerm({ taxStatus: 'director' }, DEFAULT_TERMS)).toBe(true);
    expect(movesPricedTerm({ hourlyRate: 10 }, DEFAULT_TERMS)).toBe(true);
    expect(movesPricedTerm({ dailyRate: 10 }, { ...DEFAULT_TERMS, dailyRate: 10 })).toBe(false);
  });

  it('the log mask names every term', () => {
    expect([...EMPLOYEE_TERM_LOG_KEYS].sort()).toEqual(['dailyRate', 'hourlyRate', 'hoursPerDay', 'hoursPerWeek', 'occupation', 'payBasis', 'taxStatus']);
  });
});

describe('termsFromRow on a stored status the CHECK cannot hold', () => {
  it('throws on a value it cannot map, instead of defaulting to employee', () => {
    expect(() => termsFromRow({ tax_status: 'boss' })).toThrow(/tax_status/);
    expect(() => termsFromRow({ pay_basis: 'weekly' })).toThrow(/pay_basis/);
  });

  it('a NULL column reads as the default, like a column the row does not carry', () => {
    expect(termsFromRow({ tax_status: null, pay_basis: null })).toMatchObject({ taxStatus: 'employee', payBasis: 'monthly' });
  });

  it('movedTerms looks only at the keys the patch carried', () => {
    const before = termsFromRow({ hourly_rate: null, occupation: null });
    const after = termsFromRow({ hourly_rate: '150', occupation: 'Clerk' });
    expect(movedTerms(before, after, ['occupation'])).toEqual([{ field: 'occupation', oldValue: null, newValue: 'Clerk' }]);
    expect(movedTerms(before, after).map((m) => m.field).sort()).toEqual(['hourly_rate', 'occupation']);
  });
});
