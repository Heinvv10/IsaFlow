/**
 * W29 (wave 7 PRA; rulings 7, 13, 19; review #1901): a recurring earning starting or ending strictly inside employment
 * is paid its share of the EMPLOYED WINDOW (the period cut to employment). Monthly = working days, weekly / fortnightly =
 * calendar days; the amount is the exact ratio days / of, rounded to the cent once. A starter's or leaver's own rows keep
 * full pay, and the rows of one component that split the window sum to its full amount (H1, M1).
 */
import { describe, expect, it } from 'vitest';
import {
  apportionRecurringRows, describeShare, employedWindowOf, insideEmploymentEdge, isApportionable, recurringShareOf, shareBesideOnceOffResults,
} from '@/modules/accounting/services/payroll/payrollRecurringShare';
import { employedShareOfMonth } from '@/modules/accounting/services/payroll/employmentTerms';
import { periodShareOf } from '@/modules/accounting/services/payroll/payFrequencyPeriods';
import type { EmployeeComponent } from '@/modules/accounting/services/payroll/payrollTypes';

const local = (iso: string) => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const july = { year: 2026, month: 7 }; // 23 working days; 1 July is a Wednesday
const march = { year: 2026, month: 3 }; // 22 working days; 1 March is a Sunday
const longServing = { startDate: local('2020-01-01') };
const row = (effectiveFrom: string, effectiveTo: string | null = null) => ({ effectiveFrom, effectiveTo });
const earn = (id: string, amount: number, effectiveFrom: string, effectiveTo: string | null = null, isRecurring = true): EmployeeComponent => ({
  component: { id, name: id, sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true },
  amount, isRecurring, effectiveFrom, effectiveTo,
});
const r2 = (n: number) => Math.round(n * 100) / 100;
const gross = (cs: EmployeeComponent[]) => Math.round(cs.reduce((n, c) => n + c.amount, 0) * 100) / 100;

describe('recurringShareOf: monthly, working days (ruling 13)', () => {
  it.each([
    ['starts on the 1st: whole month, not apportioned', row('2026-07-01'), null],
    ['starts on the 16th: 12 of 23 working days', row('2026-07-16'), { days: 12, of: 23 }],
    ['ends on the 10th: 8 of 23 working days', row('2020-01-01', '2026-07-10'), { days: 8, of: 23 }],
    ['ends on the last day: whole month, not apportioned', row('2020-01-01', '2026-07-31'), null],
    ['starts on the 16th and ends on the last day: 12 of 23', row('2026-07-16', '2026-07-31'), { days: 12, of: 23 }],
    ['ends on the 1st, the period\'s first day: 1 of 23', row('2020-01-01', '2026-07-01'), { days: 1, of: 23 }],
    ['starts on the 31st, the period\'s last day: 1 of 23', row('2026-07-31'), { days: 1, of: 23 }],
  ])('%s', (_label, r, want) => {
    const got = recurringShareOf('monthly', july, r, longServing);
    if (want == null) expect(got).toBeNull();
    else expect(got).toEqual({ ...want, share: want.days / want.of, basis: 'working_days' });
  });

  it('the share is employedShareOfMonth\'s ratio for a row inside a whole month (ruling 13)', () => {
    const got = recurringShareOf('monthly', july, row('2026-07-16'), longServing)!;
    expect(got.share).toBeCloseTo(employedShareOfMonth(july, local('2026-07-16')), 12);
  });

  it.each([
    ['27th', '2026-03-27', 3], ['28th (a Saturday)', '2026-03-28', 2], ['2nd (the first working day)', '2026-03-02', 22],
  ])('March 2026, a row starting on the %s: %d of 22 working days', (_d, from, days) => {
    expect(recurringShareOf('monthly', march, row(from), longServing)).toMatchObject({ days, of: 22 });
  });

  it('leap February 2028 (21 working days): from the 15th 11 of 21; on the 29th alone 1 of 21', () => {
    const feb = { year: 2028, month: 2 };
    expect(recurringShareOf('monthly', feb, row('2028-02-15'), longServing)).toMatchObject({ days: 11, of: 21 });
    expect(recurringShareOf('monthly', feb, row('2028-02-29'), longServing)).toMatchObject({ days: 1, of: 21 });
  });

  it('a weekend-only window has no working day: 0 days, and the row is dropped from the line (review M7)', () => {
    expect(recurringShareOf('monthly', { year: 2026, month: 2 }, row('2026-02-28'), longServing)).toEqual({ days: 0, of: 20, share: 0, basis: 'working_days' });
    expect(apportionRecurringRows([earn('a', 900, '2026-02-28')], { ...longServing, payFrequency: 'monthly' }, { year: 2026, month: 2 })).toEqual([]);
  });
});

describe('the employed window (ruling 19; review H1)', () => {
  it('is the period cut to employment', () => {
    expect(employedWindowOf(july, { startDate: local('2026-07-08') })).toEqual({ start: '2026-07-08', end: '2026-07-31' });
    expect(employedWindowOf(july, { startDate: local('2020-01-01'), endDate: local('2026-07-15') })).toEqual({ start: '2026-07-01', end: '2026-07-15' });
    expect(employedWindowOf(july, { startDate: local('2026-08-03') })).toBeNull();
  });

  it("a starter's own row is whole; a later row of theirs is measured against their window (10 of 18)", () => {
    const starter = { startDate: local('2026-07-08') };
    expect(insideEmploymentEdge(july, row('2026-07-08'), starter)).toBe(false);
    expect(recurringShareOf('monthly', july, row('2026-07-08'), starter)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2026-07-20'), starter)).toMatchObject({ days: 10, of: 18 });
  });

  it("a leaver's own row is whole; one ending earlier is measured against their window (8 of 20)", () => {
    const leaver = { startDate: local('2020-01-01'), endDate: new Date('2026-07-28T00:00:00Z') };
    expect(recurringShareOf('monthly', july, row('2020-01-01', '2026-07-28'), leaver)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2020-01-01', '2026-07-10'), leaver)).toMatchObject({ days: 8, of: 20 });
  });

  it("a row starting after a leaver's last day is outside employment and is not paid (review round 3 decision)", () => {
    const leaver = { startDate: local('2020-01-01'), endDate: local('2026-07-15') };
    expect(recurringShareOf('monthly', july, row('2026-07-16'), leaver)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2026-07-15'), leaver)).toMatchObject({ days: 1, of: 11 });
    expect(apportionRecurringRows([earn('sal', 10000, '2020-01-01', '2026-07-15'), earn('sal', 12000, '2026-07-20')], { ...leaver, payFrequency: 'monthly' }, july)
      .map((c) => c.amount)).toEqual([10000]);
    const ded = { ...earn('d', 100, '2026-07-20'), component: { id: 'd', name: 'd', sarsSourceCode: '4018', componentType: 'deduction' as const, isTaxable: false, isUifApplicable: false, isSdlApplicable: false } };
    expect(apportionRecurringRows([ded], { ...leaver, payFrequency: 'monthly' }, july).map((c) => c.amount)).toEqual([100]);
  });

  it('a row outside the period is not apportioned', () => {
    expect(recurringShareOf('monthly', july, row('2026-08-03'), longServing)).toBeNull();
    expect(recurringShareOf('monthly', july, row('2020-01-01', '2026-06-30'), longServing)).toBeNull();
  });

  // Breaker REPRO 1 and 2 (review #1901 H1): a starter's or leaver's split salary sums to their full-month pay.
  it.each([
    ['a leaver (15 July) re-dated on the 10th, same R10 000', { startDate: local('2020-01-01'), endDate: local('2026-07-15') },
      [earn('sal', 10000, '2020-01-01', '2026-07-09'), earn('sal', 10000, '2026-07-10')], 10000],
    ['a leaver (15 July) raised to R12 000 on the 10th: at least R10 000 (7/11 + 4/11)', { startDate: local('2020-01-01'), endDate: local('2026-07-15') },
      [earn('sal', 10000, '2020-01-01', '2026-07-09'), earn('sal', 12000, '2026-07-10')], 6363.64 + 4363.64],
    ['a starter (8 July) re-dated on the 20th, same R10 000', { startDate: local('2026-07-08') },
      [earn('sal', 10000, '2026-07-08', '2026-07-19'), earn('sal', 10000, '2026-07-20')], 10000],
  ])('%s', (_l, employee, rows, want) => {
    expect(gross(apportionRecurringRows(rows, { ...employee, payFrequency: 'monthly' }, july))).toBe(Math.round(want * 100) / 100);
  });
});

describe('weekly / fortnightly: calendar days (ruling 13), the exact ratio (review M1)', () => {
  const week = { year: 2026, month: 7, start: '2026-07-06', end: '2026-07-12' };
  const weekly = { ...longServing, payFrequency: 'weekly' as const };
  it('a row from Thursday: 4 of 7 days; prints 0.5714, as periodShareOf (G21 p. 10)', () => {
    const got = recurringShareOf('weekly', week, row('2026-07-09'), longServing)!;
    expect(got).toEqual({ days: 4, of: 7, share: 4 / 7, basis: 'calendar_days' });
    expect(describeShare(got)).toBe('4 of 7 calendar days (0.5714)');
    expect(describeShare(got)).toContain(periodShareOf('weekly', week, new Date('2026-07-09T00:00:00Z')).toFixed(4));
  });
  it('a row ending on the period\'s first day (Monday): 1 of 7; starting on its last (Sunday): 1 of 7', () => {
    expect(recurringShareOf('weekly', week, row('2020-01-01', '2026-07-06'), longServing)).toMatchObject({ days: 1, of: 7 });
    expect(recurringShareOf('weekly', week, row('2026-07-12'), longServing)).toMatchObject({ days: 1, of: 7 });
  });
  it('a week crossing into the next month: calendar days, not the month', () => {
    const crossing = { year: 2026, month: 8, start: '2026-07-27', end: '2026-08-02' };
    expect(recurringShareOf('weekly', crossing, row('2026-08-01'), longServing)).toMatchObject({ days: 2, of: 7 });
  });
  // Breaker REPRO 3: four-decimal shares made a split week pay R6 999.30.
  it('a R7 000 week split on Thursday pays R7 000; a R50 000 fortnight split on day 4 pays R50 000', () => {
    expect(gross(apportionRecurringRows([earn('w', 7000, '2020-01-01', '2026-07-08'), earn('w', 7000, '2026-07-09')], weekly, week))).toBe(7000);
    const fortnight = { year: 2026, month: 7, start: '2026-07-06', end: '2026-07-19' };
    expect(gross(apportionRecurringRows([earn('f', 50000, '2020-01-01', '2026-07-08'), earn('f', 50000, '2026-07-09')], { ...weekly, payFrequency: 'fortnightly' }, fortnight))).toBe(50000);
  });
});

describe('apportionRecurringRows', () => {
  const employee = { ...longServing, payFrequency: 'monthly' as const };
  it('multiplies the amount by days / of, to the cent, and records the share and the full amount', () => {
    const [c] = apportionRecurringRows([earn('a', 2100, '2026-07-16')], employee, july);
    expect(c!.amount).toBe(1095.65);
    expect(c!.share).toEqual({ days: 12, of: 23, share: 12 / 23, basis: 'working_days', fullAmount: 2100 });
  });
  it.each([
    ['a once-off', { isRecurring: false }],
    ['a deduction', { component: { id: 'd', name: 'd', sarsSourceCode: '4018', componentType: 'deduction' as const, isTaxable: false, isUifApplicable: false, isSdlApplicable: false } }],
    ['an hours row', { quantity: 10, quantityUnit: 'hour' as const }],
    ['a percent-of-RFI row', { percentOfRfi: 0.075 }],
    ['a defined-benefit row', { dbMemberCategoryFactor: 0.12 }],
    ['a row read without dates', { effectiveFrom: undefined }],
  ])('leaves %s alone', (_l, over) => {
    const c = { ...earn('a', 2100, '2026-07-16'), ...over } as EmployeeComponent;
    expect(apportionRecurringRows([c], employee, july)[0]!.amount).toBe(2100);
    if (!('effectiveFrom' in over)) expect(isApportionable(c)).toBe(false);
  });
});

describe('describeShare', () => {
  it('prints days and the share to four decimals, truncated', () => {
    expect(describeShare({ days: 12, of: 23, share: 12 / 23, basis: 'working_days' })).toBe('12 of 23 working days (0.5217)');
    expect(describeShare({ days: 3, of: 7, share: 3 / 7, basis: 'calendar_days' })).toBe('3 of 7 calendar days (0.4285)');
  });
});

describe('shareBesideOnceOffResults (review M2): a share beside any once-off EARNING is recorded for acknowledgement', () => {
  const employee = { ...longServing, payFrequency: 'monthly' as const };
  // Breaker REPRO 5: the old guard's advice (end the row, pay its days as a once-off) on another component.
  it('pairs an ended allowance with a hand once-off of another component, naming both and keyed on rows and amounts', () => {
    const rows = apportionRecurringRows([earn('allow', 2300, '2020-01-01', '2026-07-10'), earn('allow-prorata', 800, '2026-07-01', '2026-07-31', false)], employee, july);
    expect(gross(rows)).toBe(1600);
    const [r, ...rest] = shareBesideOnceOffResults(rows);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ code: 'RECURRING_SHARE_BESIDE_ONCE_OFF', severity: 'warning' });
    expect(r!.message).toContain('allow (8 of 23 working days (0.3478))');
    expect(r!.message).toContain('allow-prorata 800.00');
    expect(r!.pairKey).toBe('share[allow:800.00]once[allow-prorata:800.00]');
  });
  it('a changed amount on either side changes the key', () => {
    const key = (once: number) => shareBesideOnceOffResults(apportionRecurringRows(
      [earn('allow', 2300, '2020-01-01', '2026-07-10'), earn('x', once, '2026-07-01', '2026-07-31', false)], employee, july))[0]!.pairKey;
    expect(key(800)).not.toBe(key(801));
  });
  it('says nothing without a share, without a once-off earning, or beside a once-off deduction', () => {
    expect(shareBesideOnceOffResults(apportionRecurringRows([earn('a', 2100, '2026-07-16')], employee, july))).toEqual([]);
    expect(shareBesideOnceOffResults([earn('a', 2100, '2020-01-01'), earn('b', 50, '2026-07-01', '2026-07-31', false)])).toEqual([]);
    const ded = { ...earn('d', 50, '2026-07-01', '2026-07-31', false), component: { id: 'd', name: 'd', sarsSourceCode: '4018', componentType: 'deduction' as const, isTaxable: false, isUifApplicable: false, isSdlApplicable: false } };
    expect(shareBesideOnceOffResults([...apportionRecurringRows([earn('a', 2100, '2026-07-16')], employee, july), ded])).toEqual([]);
  });
});

describe('review #1901 round 2', () => {
  const employee = { ...longServing, payFrequency: 'monthly' as const };
  // Breaker R2 repro: three rows of one amount, split anywhere in July, foot to the cent (R2-L1).
  it('three rows of one amount tile the month and foot to the cent, every split', () => {
    const bad: string[] = [];
    const d = (n: number) => `2026-07-${String(n).padStart(2, '0')}`;
    for (const amt of [10000.01, 33333.33, 12345.67]) for (let a = 2; a <= 29; a++) for (let b = a + 1; b <= 30; b++) {
      const g = gross(apportionRecurringRows([earn('s', amt, '2020-01-01', d(a - 1)), earn('s', amt, d(a), d(b - 1)), earn('s', amt, d(b))], employee, july));
      if (g !== amt) bad.push(`${amt} split ${a}/${b} -> ${g}`);
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });
  it('rows of different amounts (a raise) are each rounded to the cent', () => {
    const rows = apportionRecurringRows([earn('s', 10000, '2020-01-01', '2026-07-09'), earn('s', 12000, '2026-07-10')], employee, july);
    expect(rows.map((r) => r.amount)).toEqual([r2(10000 * 7 / 23), r2(12000 * 16 / 23)]);
  });
  it('an employed window with no working day splits by calendar days, so a pair sums to the whole (R2-L3)', () => {
    // Employed Saturday 28 to Sunday 29 March 2026 only: no working day. Re-dated on the Sunday, each row pays one of two days.
    const mar = { year: 2026, month: 3 };
    const starter = { startDate: local('2026-03-28'), endDate: local('2026-03-29'), payFrequency: 'monthly' as const };
    const rows = apportionRecurringRows([earn('s', 9000, '2026-03-28', '2026-03-28'), earn('s', 9000, '2026-03-29')], starter, mar);
    expect(rows.map((r) => r.share && `${r.share.days}/${r.share.of} ${r.share.basis}`)).toEqual(['1/2 calendar_days', '1/2 calendar_days']);
    expect(gross(rows)).toBe(9000);
  });
});

// Breaker round 3 (unit): the remainder only for a true tiling.
describe('review #1901 round 3: the remainder is only for rows that tile the window', () => {
  const employee = { ...longServing, payFrequency: 'monthly' as const };
  const d = (n: number) => `2026-07-${String(n).padStart(2, '0')}`;
  it('a gap: no row is topped up past its own share', () => {
    const gap = apportionRecurringRows([earn('s', 10000.01, '2020-01-01', d(9)), earn('s', 10000.01, d(15))], employee, july);
    expect(gap.map((r) => r.amount)).toEqual([r2(10000.01 * 7 / 23), r2(10000.01 * 13 / 23)]);
    expect(gross(gap)).toBeLessThan(10000.01);
  });
  it('an overlap that makes up a gap (days add up to the month) is not a tiling: each row is its own share', () => {
    // R33 333.33: the three own shares (10 144.93 + 21 739.13 + 1 449.28) add to a cent more than the amount, so a
    // remainder applied here would move the last row: it must not.
    const rows = apportionRecurringRows([earn('s', 33333.33, '2020-01-01', d(9)), earn('s', 33333.33, d(13)), earn('s', 33333.33, d(6), d(6))], employee, july);
    expect(rows.map((r) => r.amount)).toEqual([r2(33333.33 * 7 / 23), r2(33333.33 * 15 / 23), r2(33333.33 * 1 / 23)]);
    expect(gross(rows)).toBe(33333.34);
  });
});

