/**
 * Pure VAT profile rules: number formats, how vat_category / vat_alignment resolve against the company's current
 * cycle, and the periods a category change moves.
 */
import { describe, expect, it } from 'vitest';
import {
  categoryOf, isValidSaVatNumber, periodImpact, periodsAround, resolveDesired, stateFromColumns,
  type VatProfileState,
} from '@/modules/accounting/services/core/companyVatProfile';

const state = (over: Partial<VatProfileState> = {}): VatProfileState => ({
  vatNumber: null, incomeTaxNumber: null, setting: 'bi-monthly', alignment: 'odd', ...over,
});
const NOV_13 = new Date('2026-11-13T09:00:00Z');

describe('isValidSaVatNumber', () => {
  it('accepts ten digits starting with 4 only', () => {
    expect(isValidSaVatNumber('4123456789')).toBe(true);
    for (const bad of ['3123456789', '412345678', '41234567890', '4123 56789', '412345678X', '']) {
      expect(isValidSaVatNumber(bad), bad).toBe(false);
    }
  });
});

describe('categoryOf / stateFromColumns', () => {
  it('derives A, B, C and none the way vatPeriodHelper documents them', () => {
    expect(categoryOf('bi-monthly', 'odd')).toBe('A');
    expect(categoryOf('bi-monthly', 'even')).toBe('B');
    expect(categoryOf('monthly', 'even')).toBe('C');
    expect(categoryOf('none', 'odd')).toBe('none');
  });
  it('reads mixed-case legacy columns and a none system type', () => {
    expect(stateFromColumns({ vatNumber: null, taxNumber: null, vatPeriod: 'Bi-Monthly', vatSystemType: 'invoice', vatPeriodAlignment: 'EVEN' }))
      .toMatchObject({ setting: 'bi-monthly', alignment: 'even' });
    expect(stateFromColumns({ vatNumber: null, taxNumber: null, vatPeriod: 'monthly', vatSystemType: 'none', vatPeriodAlignment: 'odd' }).setting)
      .toBe('none');
  });
});

describe('resolveDesired', () => {
  it('maps A, B and C to cadence and alignment', () => {
    expect(resolveDesired(state(), { category: 'B' })).toEqual({ cadence: 'bi-monthly', alignment: 'even' });
    expect(resolveDesired(state({ setting: 'monthly' }), { category: 'A' })).toEqual({ cadence: 'bi-monthly', alignment: 'odd' });
    expect(resolveDesired(state(), { category: 'C' })).toMatchObject({ cadence: 'monthly' });
  });
  it('alignment alone moves a bi-monthly company between A and B, and refuses a monthly one', () => {
    expect(resolveDesired(state(), { alignment: 'even' })).toEqual({ cadence: 'bi-monthly', alignment: 'even' });
    expect(resolveDesired(state({ setting: 'monthly' }), { alignment: 'even' })).toMatchObject({ error: expect.stringContaining('monthly') });
  });
  it('refuses a category that disagrees with the alignment sent with it, and alignment with C', () => {
    expect(resolveDesired(state(), { category: 'A', alignment: 'even' })).toMatchObject({ error: expect.stringContaining('odd') });
    expect(resolveDesired(state(), { category: 'B', alignment: 'even' })).toEqual({ cadence: 'bi-monthly', alignment: 'even' });
    expect(resolveDesired(state(), { category: 'C', alignment: 'odd' })).toMatchObject({ error: expect.stringContaining('bi-monthly') });
  });
  it('refuses any cycle change for a company that is not VAT registered, but not a number-only request', () => {
    const none = state({ setting: 'none' });
    expect(resolveDesired(none, { category: 'A' })).toMatchObject({ error: expect.stringContaining('not registered') });
    expect(resolveDesired(none, { alignment: 'odd' })).toMatchObject({ error: expect.stringContaining('not registered') });
    expect('error' in resolveDesired(none, { vatNumber: '4123456789' })).toBe(false);
  });
});

describe('periodImpact', () => {
  it('gives the periods around a date for each category', () => {
    expect(periodsAround('bi-monthly', 'odd', NOV_13)).toEqual({
      current: { from: '2026-10-01', to: '2026-11-30' }, next: { from: '2026-12-01', to: '2027-01-31' },
    });
    expect(periodsAround('bi-monthly', 'even', NOV_13)).toEqual({
      current: { from: '2026-11-01', to: '2026-12-31' }, next: { from: '2027-01-01', to: '2027-02-28' },
    });
    expect(periodsAround('monthly', 'odd', NOV_13)).toEqual({
      current: { from: '2026-11-01', to: '2026-11-30' }, next: { from: '2026-12-01', to: '2026-12-31' },
    });
  });
  it('reports old against new for A to B and flags the change', () => {
    const i = periodImpact(state(), { cadence: 'bi-monthly', alignment: 'even' }, NOV_13);
    expect(i).toMatchObject({
      as_of: '2026-11-13', changes_periods: true,
      current: { old: { from: '2026-10-01', to: '2026-11-30' }, new: { from: '2026-11-01', to: '2026-12-31' } },
      next: { old: { from: '2026-12-01', to: '2027-01-31' }, new: { from: '2027-01-01', to: '2027-02-28' } },
    });
  });
  it('flags A to C and reports no change for the same category', () => {
    expect(periodImpact(state(), { cadence: 'monthly', alignment: 'odd' }, NOV_13).changes_periods).toBe(true);
    expect(periodImpact(state(), { cadence: 'bi-monthly', alignment: 'odd' }, NOV_13).changes_periods).toBe(false);
  });
});
