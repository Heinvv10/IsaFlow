/**
 * Wave 6 FQc, the pure parts of the weekly and fortnightly engine: the period share, the EMP201 month, the run that
 * closes its month, UIF on the month to date, the ETI month parts, the factor by frequency, and the run-keyed journal
 * description. The figures end to end are the oracle cases (payrollOracle.test.ts) and w6-fqc-freq-engine.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  closesPayMonth, emp201MonthOf, isoOfDate, payDateOf, periodShareOf,
} from '@/modules/accounting/services/payroll/payFrequencyPeriods';
import { uifWithLeviable } from '@/modules/accounting/services/payroll/uifEngine';
import { addEtiMonthParts, NO_ETI_PARTS } from '@/modules/accounting/services/payroll/payrollLineEtiMonth';
import { cadenceTermsOf } from '@/modules/accounting/services/payroll/payrollLineCadence';
import { RUN_KEYED_JOURNAL, runJournalDescriptionOf } from '@/modules/accounting/services/payroll/payrollJournalDescription';
import type { PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';

const week = { start: '2026-06-01', end: '2026-06-07' };

describe('periodShareOf: the share of a weekly or fortnightly period employed (G21 p. 10 prints 3 of 7 as 0.4285)', () => {
  it('3 of 7 days is 0.4285, truncated to four decimals, not rounded to 0.4286', () => {
    expect(periodShareOf('weekly', week, new Date('2026-06-05T00:00:00Z'))).toBe(0.4285);
  });
  it('a whole week is 1, and a monthly line is always 1', () => {
    expect(periodShareOf('weekly', week, new Date('2020-01-01T00:00:00Z'))).toBe(1);
    expect(periodShareOf('monthly', week, new Date('2026-06-05T00:00:00Z'))).toBe(1);
  });
  it('a leaver: start and end inclusive; employed on no day of the period is 0', () => {
    expect(periodShareOf('fortnightly', { start: '2026-06-01', end: '2026-06-14' }, new Date('2020-01-01T00:00:00Z'), new Date('2026-06-07T00:00:00Z')))
      .toBe(0.5);
    expect(periodShareOf('weekly', week, new Date('2026-06-08T00:00:00Z'))).toBe(0);
  });
  it('a start date read at local midnight is the same calendar day', () => {
    expect(isoOfDate(new Date(2026, 5, 5))).toBe('2026-06-05');
  });
});

describe('the EMP201 month is the pay date\'s (Fourth Schedule para 2(1)), and which run closes its month', () => {
  it('a week from 29 June paid 3 July is July\'s', () => {
    expect(emp201MonthOf(payDateOf({ end: '2026-07-05' }, '2026-07-03')!)).toEqual({ year: 2026, month: 7 });
    expect(payDateOf({ end: '2026-07-05' }, null)).toBe('2026-07-05');
  });
  it('a weekly run closes its month when the next pay date (+7 days) is in a later month', () => {
    expect(closesPayMonth('weekly', '2026-06-26')).toBe(true);
    expect(closesPayMonth('weekly', '2026-06-23')).toBe(false);
    expect(closesPayMonth('fortnightly', '2026-06-17')).toBe(true);
    expect(closesPayMonth('fortnightly', '2026-06-16')).toBe(false);
    expect(closesPayMonth('monthly', '2026-06-01')).toBe(true);
  });
});

describe('UIF on the month to date (UIC Act s6(1)(a); ceiling R17 712 a month)', () => {
  it('levies only the room left under the month\'s ceiling after earlier runs', () => {
    expect(uifWithLeviable(6000, 2027, 12000).leviable).toBe(5712);
    expect(uifWithLeviable(6000, 2027, 18000).leviable).toBe(0);
    expect(uifWithLeviable(6000, 2027, 0).leviable).toBe(6000);
    expect(uifWithLeviable(6000, 2027).uif.employeeContribution).toBe(60);
  });
});

describe('ETI month parts add up; an unknown ordinary-hours part makes the month\'s unknown', () => {
  it('sums', () => {
    const a = { remuneration: 1000.004, wageCents: 100000, ordinaryHours: 40, overtimeHours: 1 };
    expect(addEtiMonthParts(NO_ETI_PARTS, a)).toEqual({ remuneration: 1000, wageCents: 100000, ordinaryHours: 40, overtimeHours: 1 });
    expect(addEtiMonthParts(a, { ...a, ordinaryHours: null }).ordinaryHours).toBeNull();
  });
});

describe('cadenceTermsOf: F by frequency (ruling 16: × 52 / × 26), monthly unchanged', () => {
  const base = { employee: { startDate: new Date('2020-01-01T00:00:00Z'), endDate: null }, period: { year: 2026, month: 6 } } as unknown as PayrollLineInput;
  it('monthly (no cadence): 365 ÷ 30.4166, share 1', () => {
    expect(cadenceTermsOf(base)).toMatchObject({ frequency: 'monthly', factor: 365 / 30.4166, periodShare: 1, uifMonthToDate: 0 });
  });
  it('weekly 52, fortnightly 26; a week\'s time-worked pay is read as 52/12 weeks a month', () => {
    const cadence = { frequency: 'weekly' as const, periodStart: week.start, periodEnd: week.end, uifMonthToDate: 100, etiMonthToDate: null };
    const weekly = cadenceTermsOf({ ...base, cadence });
    expect(weekly).toMatchObject({ factor: 52, periodShare: 1, uifMonthToDate: 100 });
    expect(weekly.dayPay(1200).earnings).toBeCloseTo(5200, 9);
    expect(cadenceTermsOf({ ...base, cadence: { ...cadence, frequency: 'fortnightly', periodEnd: '2026-06-14' } }).factor).toBe(26);
  });
});

describe('the run-keyed journal description (OC adopts it for off-cycle runs)', () => {
  const row = { period_year: 2026, period_month: 5, pay_frequency: 'monthly', run_kind: 'regular', off_cycle_reason: null, run_date: null, period_end: '2026-05-31' };
  it('a monthly regular run keeps "Payroll run 2026-05"', () => {
    expect(runJournalDescriptionOf(row)).toBe('Payroll run 2026-05');
  });
  it('weekly, fortnightly and off-cycle runs name their kind and pay date, and the guard\'s pattern reads them back', () => {
    const weekly = runJournalDescriptionOf({ ...row, pay_frequency: 'weekly', period_end: '2026-05-08' });
    const bonus = runJournalDescriptionOf({ ...row, run_kind: 'off_cycle', off_cycle_reason: 'bonus', run_date: new Date('2026-05-28T00:00:00Z') });
    expect([weekly, bonus]).toEqual(['Payroll run 2026-05 weekly, paid 2026-05-08', 'Payroll run 2026-05 bonus, paid 2026-05-28']);
    expect(RUN_KEYED_JOURNAL.exec(bonus)?.slice(1)).toEqual(['2026', '05', 'bonus', '2026-05-28']);
    expect(RUN_KEYED_JOURNAL.test('Payroll run 2026-05')).toBe(false);
  });
});
