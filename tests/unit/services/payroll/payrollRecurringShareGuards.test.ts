/**
 * W29 review #1901: the guards around the share.
 *  - M3: a paid run of version 21+ paid a recurring row by its dates, so moving a start or end that lies in the paid month
 *    is refused even when the row is still read (breaker REPRO 4); version 20 keeps the old "was it read" rule.
 *  - L2: the pro-rata guard's mapping of a stored row (sharePays): an hours, percent-of-RFI, defined-benefit or deduction
 *    row is not one the share pays.
 *  - M6: the explanation states the share.
 */
import { describe, expect, it } from 'vitest';
import { paidPeriodChanged, SHARE_BY_DATES_VERSION } from '@/modules/accounting/services/payroll/payrollComponentPaidMonths';
import { sharePays } from '@/modules/accounting/services/payroll/payrollRecurringProRata';
import { earningStep } from '@/modules/accounting/services/payroll/earningExplain';
import { PAYROLL_CALCULATION_VERSION } from '@/modules/accounting/services/payroll/payrollCalculationVersion';

const july = (version: number | null) => [{ year: 2026, month: 7, calculatedAt: Date.parse('2026-07-31T12:00:00Z'), version }];
const w = (from: string, to: string | null) => ({ from, to, recurring: true });

describe('paidPeriodChanged under W29 (M3)', () => {
  it('the version the guard keys on is the one that introduced the share', () => {
    expect(SHARE_BY_DATES_VERSION).toBe(21);
    expect(PAYROLL_CALCULATION_VERSION).toBeGreaterThanOrEqual(SHARE_BY_DATES_VERSION);
  });
  it.each([
    ['an ended row moved from the 10th to the 20th', w('2020-01-01', '2026-07-10'), w('2020-01-01', '2026-07-20')],
    ['a raise moved from the 16th to the 2nd', w('2026-07-16', null), w('2026-07-02', null)],
    ['an open row ended inside the month', w('2020-01-01', null), w('2020-01-01', '2026-07-20')],
    ['an end moved from August into July', w('2020-01-01', '2026-08-10'), w('2020-01-01', '2026-07-20')],
  ])('version 21: %s is refused', (_l, before, after) => {
    expect(paidPeriodChanged(july(21), before, after)).not.toBeNull();
  });
  it('version 20: an ended row moved inside the month is allowed (it was not read, and still is not)', () => {
    expect(paidPeriodChanged(july(20), w('2020-01-01', '2026-07-10'), w('2020-01-01', '2026-07-20'))).toBeNull();
  });
  it('version 21: a start or end moved outside the paid month is allowed', () => {
    expect(paidPeriodChanged(july(21), w('2020-01-01', '2026-08-10'), w('2020-01-01', '2026-08-20'))).toBeNull();
    expect(paidPeriodChanged(july(21), { from: '2026-08-01', to: null, recurring: true }, { from: '2026-08-05', to: null, recurring: true })).toBeNull();
  });
});

const stored = (over: Record<string, unknown>) => ({
  component_type: 'earning', quantity: null, percent_of_rfi: null, db_member_category_factor: null,
  effective_from: '2026-07-16', effective_to: null, start_date: '2020-01-01', end_date: null, ...over,
});

describe('sharePays (L2)', () => {
  const period = { year: 2026, month: 7 };
  it('a plain recurring earning starting inside employment is one the share pays', () => {
    expect(sharePays(period, stored({}))).toBe(true);
  });
  it.each([
    ['an hours row', { quantity: 10 }], ['a percent-of-RFI row', { percent_of_rfi: 0.075 }], ['a defined-benefit row', { db_member_category_factor: 0.12 }],
    ['a deduction', { component_type: 'deduction' }], ["a starter's own row", { start_date: '2026-07-16' }], ["a row starting after a leaver's last day", { end_date: '2026-07-15' }],
  ])('%s is not', (_l, over) => {
    expect(sharePays(period, stored(over))).toBe(false);
  });
});

describe('the explanation step (M6)', () => {
  it('shows days of the full amount, the full amount and the share as parts', () => {
    const step = earningStep('e1', {
      name: 'Standby allowance', code: '3601', amount: 1095.65, included: 1095.65, isNonCash: false, taxable: true, uif: true, sdl: true,
      treatment: 'periodic', share: { share: 12 / 23, days: 12, of: 23, basis: 'working_days', fullAmount: 2100 },
    } as Parameters<typeof earningStep>[1]);
    expect(step.amount).toBe(1095.65);
    expect(step.formula).toMatch(/^12 of 23 working days of R.?2.?100\.00, to the cent$/);
    expect(step.children?.map((c) => [c.label, c.amount])).toEqual([['The amount for a whole period', 2100], ['The share of the period it ran', 12 / 23]]);
  });
});

// Review #1901 round 2 (breaker round-2 unit repros ported).
describe('paidPeriodChanged judges the change in what the paid run paid (R2-H1)', () => {
  it('cutting an open row to the paid month\'s last day is allowed (a package from the 1st of the next month)', () => {
    expect(paidPeriodChanged(july(21), w('2020-01-01', null), w('2020-01-01', '2026-07-31'))).toBeNull();
  });
  it('cutting it to the 20th is refused; so is moving an inside start (16th -> 20th) on a reopened v21 run', () => {
    expect(paidPeriodChanged(july(21), w('2020-01-01', null), w('2020-01-01', '2026-07-20'))).not.toBeNull();
    const reopened = [{ year: 2026, month: 7, calculatedAt: 1, version: 21, reopened: true }];
    expect(paidPeriodChanged(reopened, w('2026-07-16', null), w('2026-07-20', null))).not.toBeNull();
  });
  it('a leaver\'s window: moving the end after their last day changes nothing the run paid by its dates', () => {
    const lw = (to: string | null) => ({ from: '2020-01-01', to, recurring: true, employeeEnd: '2026-07-15' });
    expect(paidPeriodChanged(july(21), lw('2026-07-25'), lw('2026-07-28'))).toBeNull();
  });
  it('R2-L2: a weekly run crossing a month end (27 Jul - 2 Aug, EMP201 August) is judged on its own dates', () => {
    const week = [{ year: 2026, month: 8, calculatedAt: 1, version: 21, runStart: '2026-07-27', runEnd: '2026-08-02', frequency: 'weekly' }];
    expect(paidPeriodChanged(week, w('2020-01-01', '2026-07-29'), w('2020-01-01', '2026-07-31'))).not.toBeNull();
    expect(paidPeriodChanged(week, w('2020-01-01', '2026-07-20'), w('2020-01-01', '2026-07-24'))).toBeNull();
  });
});

describe('the explanation of a fringe earning that ran for part of the period (R2-L4)', () => {
  it('a 3701 at its 80% share also shows the days it ran', () => {
    const step = earningStep('t', {
      name: 'Travel allowance', code: '3701', amount: 1000, included: 800, rate: 0.8, isNonCash: false, taxable: true, uif: true, sdl: true,
      treatment: 'periodic', share: { share: 10 / 23, days: 10, of: 23, basis: 'working_days', fullAmount: 2300 },
    } as Parameters<typeof earningStep>[1]);
    expect(step.amount).toBe(800);
    expect(step.children?.[0]).toMatchObject({ key: 't.period', amount: 1000 });
    expect(step.children?.[0]?.formula).toMatch(/^10 of 23 working days of R/);
  });
});

