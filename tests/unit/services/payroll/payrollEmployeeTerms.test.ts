/**
 * Employee work terms (mig 967): what create and PATCH accept, the director prompt, and the history diff.
 * Limits follow the migration's CHECKs: hours a week 0 < h <= 168, a day 0 < h <= 24, rates >= 0 to the cent,
 * occupation <= 100 characters (BCEA s33(1)(b) is the payslip's reason for it).
 */
import { describe, expect, it } from 'vitest';
import {
  directorStatusPrompt, movedTerms, termsFromRow, termsOfCreate, termsOfPatch,
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
  it('reads pg NUMERIC text as numbers and an unknown status as the default', () => {
    expect(termsFromRow({ tax_status: 'director', pay_basis: 'hourly', hours_per_week: '40.00', hourly_rate: '185.50' })).toMatchObject({
      taxStatus: 'director', payBasis: 'hourly', hoursPerWeek: 40, hourlyRate: 185.5, dailyRate: null, occupation: null,
    });
    expect(termsFromRow({ tax_status: 'x' }).taxStatus).toBe('employee');
  });

  it('lists only the terms that moved, by column name', () => {
    const before = termsFromRow({ tax_status: 'employee', pay_basis: 'monthly', hours_per_week: '40.00' });
    const after = termsFromRow({ tax_status: 'director', pay_basis: 'monthly', hours_per_week: '40' });
    expect(movedTerms(before, after)).toEqual([{ field: 'tax_status', oldValue: 'employee', newValue: 'director' }]);
  });
});
