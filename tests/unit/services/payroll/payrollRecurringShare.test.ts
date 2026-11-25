/**
 * W29 (wave 7 PRA; rulings 7, 13, 19): a recurring earning starting or ending strictly inside employment is paid its
 * share of the period. Monthly = working days (employedShareOfMonth), weekly / fortnightly = calendar days (periodShareOf,
 * G21 (2027) Rev 1 p. 10's "3 of 7 days = 0.4285"). A starter's or leaver's own rows keep full pay (ruling 19).
 */
import { describe, expect, it } from 'vitest';
import {
  apportionRecurringRows, describeShare, insideEmploymentEdge, isApportionable, recurringShareOf, shareBesideOnceOffWarnings,
} from '@/modules/accounting/services/payroll/payrollRecurringShare';
import type { EmployeeComponent } from '@/modules/accounting/services/payroll/payrollTypes';

const local = (iso: string) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const july = { year: 2026, month: 7 }; // 23 working days; 1 July is a Wednesday
const march = { year: 2026, month: 3 }; // 22 working days; 1 March is a Sunday
const longServing = { startDate: local('2020-01-01') };
const row = (effectiveFrom: string, effectiveTo: string | null = null) => ({ effectiveFrom, effectiveTo });

describe('recurringShareOf: monthly, working days (ruling 13)', () => {
  it.each([
    ['starts on the 1st: whole month, not apportioned', row('2026-07-01'), null],
    ['starts on the 16th: 12 of 23 working days', row('2026-07-16'), { days: 12, of: 23, share: 12 / 23 }],
    ['ends on the 10th: 8 of 23 working days', row('2020-01-01', '2026-07-10'), { days: 8, of: 23, share: 8 / 23 }],
    ['ends on the last day: whole month, not apportioned', row('2020-01-01', '2026-07-31'), null],
    ['starts on the 16th and ends on the last day: 12 of 23', row('2026-07-16', '2026-07-31'), { days: 12, of: 23, share: 12 / 23 }],
  ])('%s', (_label, r, want) => {
    const got = recurringShareOf('monthly', july, r, longServing);
    if (want == null) expect(got).toBeNull();
    else expect(got).toEqual({ ...want, basis: 'working_days' });
  });

  it.each([
    ['27th', '2026-03-27', 3], ['28th (a Saturday)', '2026-03-28', 2], ['2nd (the first working day)', '2026-03-02', 22],
  ])('March 2026, a row starting on the %s: %d of 22 working days', (_d, from, days) => {
    expect(recurringShareOf('monthly', march, row(from), longServing)).toMatchObject({ days, of: 22, share: days / 22 });
  });

  it('a row ending on the 27th / 30th of March: 20 and 21 of 22 working days', () => {
    expect(recurringShareOf('monthly', march, row('2020-01-01', '2026-03-27'), longServing)).toMatchObject({ days: 20, of: 22 });
    expect(recurringShareOf('monthly', march, row('2020-01-01', '2026-03-30'), longServing)).toMatchObject({ days: 21, of: 22 });
  });

  it('leap February 2028 (21 working days): from the 15th 11 of 21; on the 29th alone 1 of 21', () => {
    const feb = { year: 2028, month: 2 };
    expect(recurringShareOf('monthly', feb, row('2028-02-15'), longServing)).toMatchObject({ days: 11, of: 21 });
    expect(recurringShareOf('monthly', feb, row('2028-02-29'), longServing)).toMatchObject({ days: 1, of: 21 });
  });

  it('a weekend-only window pays 0, not the one-day floor employedShareOfMonth gives a starter', () => {
    expect(recurringShareOf('monthly', { year: 2026, month: 2 }, row('2026-02-28'), longServing)).toEqual({ days: 0, of: 20, share: 0, basis: 'working_days' });
  });
});

describe('inside employment only (ruling 19)', () => {
  it("a starter's own row (from their start date) is not apportioned; a later row of theirs is", () => {
    const starter = { startDate: local('2026-07-16') };
    expect(insideEmploymentEdge(july, row('2026-07-16'), starter)).toBe(false);
    expect(recurringShareOf('monthly', july, row('2026-07-16'), starter)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2026-07-20'), starter)).toMatchObject({ days: 10, of: 23 });
  });

  it("a leaver's own row (to their end date) is not apportioned; one ending earlier is, and stops at the row's end", () => {
    const leaver = { startDate: local('2020-01-01'), endDate: new Date('2026-07-28T00:00:00Z') };
    expect(recurringShareOf('monthly', july, row('2020-01-01', '2026-07-28'), leaver)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2020-01-01', '2026-07-10'), leaver)).toMatchObject({ days: 8, of: 23 });
  });

  it("a row starting inside a leaver's month stops at their end date (its window inside employment)", () => {
    const leaver = { startDate: local('2020-01-01'), endDate: local('2026-07-24') };
    expect(recurringShareOf('monthly', july, row('2026-07-16'), leaver)).toMatchObject({ days: 7, of: 23 });
  });

  it("a row starting after a leaver's last day is outside employment: not apportioned (today's pay kept)", () => {
    const leaver = { startDate: local('2020-01-01'), endDate: local('2026-07-15') };
    expect(recurringShareOf('monthly', july, row('2026-07-16'), leaver)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2026-07-15'), leaver)).toMatchObject({ days: 1, of: 23 });
  });

  it('a row outside the period is not apportioned', () => {
    expect(recurringShareOf('monthly', july, row('2026-08-03'), longServing)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2020-01-01', '2026-06-30'), longServing)).toBeNull();
  });
});

describe('weekly / fortnightly: calendar days, periodShareOf (ruling 13)', () => {
  const week = { year: 2026, month: 7, start: '2026-07-06', end: '2026-07-12' };
  it('a row from Thursday: 4 of 7 days, 0.5714 (truncated, as G21 p. 10)', () => {
    expect(recurringShareOf('weekly', week, row('2026-07-09'), longServing)).toEqual({ days: 4, of: 7, share: 0.5714, basis: 'calendar_days' });
  });
  it('a row ending Wednesday: 3 of 7 days, 0.4285', () => {
    expect(recurringShareOf('weekly', week, row('2020-01-01', '2026-07-08'), longServing)).toMatchObject({ days: 3, share: 0.4285 });
  });
  it('fortnightly: from day 4 of 14, 11 of 14 days', () => {
    const fortnight = { year: 2026, month: 7, start: '2026-07-06', end: '2026-07-19' };
    expect(recurringShareOf('fortnightly', fortnight, row('2026-07-09'), longServing)).toMatchObject({ days: 11, of: 14, share: 0.7857 });
  });
});

const comp = (over: Partial<EmployeeComponent> & { type?: string }): EmployeeComponent => ({
  component: { id: 'c', name: 'Allowance', sarsSourceCode: '3713', componentType: (over.type ?? 'earning') as 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true },
  amount: 2100, isRecurring: true, effectiveFrom: '2026-07-16', effectiveTo: null, ...over,
});

describe('apportionRecurringRows', () => {
  const employee = { ...longServing, payFrequency: 'monthly' as const };
  it('multiplies the amount to the cent and records the share and the full amount', () => {
    const [c] = apportionRecurringRows([comp({})], employee, july);
    expect(c!.amount).toBe(1095.65);
    expect(c!.share).toEqual({ days: 12, of: 23, share: 12 / 23, basis: 'working_days', fullAmount: 2100 });
  });
  it.each([
    ['a once-off', { isRecurring: false }],
    ['a deduction', { type: 'deduction' }],
    ['an hours row', { quantity: 10, quantityUnit: 'hour' as const }],
    ['a percent-of-RFI row', { percentOfRfi: 0.075 }],
    ['a row read without dates', { effectiveFrom: undefined }],
  ])('leaves %s alone', (_l, over) => {
    expect(isApportionable(comp(over)) && comp(over).effectiveFrom !== undefined).toBe(false);
    expect(apportionRecurringRows([comp(over)], employee, july)[0]!.amount).toBe(2100);
  });
});

describe('describeShare', () => {
  it('prints days and the share to four decimals, truncated', () => {
    expect(describeShare({ days: 12, of: 23, share: 12 / 23, basis: 'working_days' })).toBe('12 of 23 working days (0.5217)');
    expect(describeShare({ days: 3, of: 7, share: 0.4285, basis: 'calendar_days' })).toBe('3 of 7 calendar days (0.4285)');
  });
});

describe('shareBesideOnceOffWarnings: a hand pro-rata from before W29 may now pay the same days twice', () => {
  const employee = { ...longServing, payFrequency: 'monthly' as const };
  it('warns (not blocking) when an apportioned row has a once-off of the same component in the period', () => {
    const rows = apportionRecurringRows([comp({ effectiveFrom: '2020-01-01', effectiveTo: '2026-07-10' }), comp({ isRecurring: false, amount: 500, effectiveFrom: '2026-07-01', effectiveTo: '2026-07-10' })], employee, july);
    const w = shareBesideOnceOffWarnings(rows);
    expect(w).toEqual([expect.objectContaining({ code: 'RECURRING_SHARE_BESIDE_ONCE_OFF', severity: 'warning' })]);
    expect(w[0]!.message).toContain('8 of 23 working days (0.3478)');
  });
  it('says nothing without a once-off of that component, or without a share', () => {
    expect(shareBesideOnceOffWarnings(apportionRecurringRows([comp({})], employee, july))).toEqual([]);
    expect(shareBesideOnceOffWarnings([comp({ effectiveFrom: '2020-01-01' }), comp({ isRecurring: false })])).toEqual([]);
  });
});

