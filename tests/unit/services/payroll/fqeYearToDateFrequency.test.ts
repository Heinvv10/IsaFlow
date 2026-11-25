/**
 * FQe (wave 7, Hein ruling 23, engine 23): after a mid-tax-year change of pay frequency the year to date's periods
 * (PAYE's n) are expressed in the current line's frequency, each earlier period counted as the share of a year its own
 * frequency gave it (share / F), and the s11F cap periods as the statutory share (share / P). SARS is silent on a change
 * of pay period (PAYE-GEN-01-G21 (2027) Rev 1 p. 8-9), so the line carries PAY_FREQUENCY_CHANGED_IN_YEAR (UNVERIFIED).
 */
import { describe, expect, it } from 'vitest';
import { PAY_FREQUENCY_CHANGED, ytdInFrequency } from '@/modules/accounting/services/payroll/payrollYearToDateFrequency';
import { loadCases, runCase } from '../../../fixtures/payroll-oracle/oracle';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const base: PayeYearToDate = {
  periods: 4, periodicTaxable: 32_000, annualPayments: 0, tablePaye: 5_567.48, medicalCredit: 0, additionalMedicalCredit: 0,
  medicalSchemeFees: 0, retirementCapPeriods: 4,
};
const F_MONTH = 365 / 30.4166;

describe('ytdInFrequency (FQe)', () => {
  it('four weeks are two fortnights (x 26 / 52), and the line warns', () => {
    const { ytd, warnings } = ytdInFrequency({ ...base, frequencies: ['weekly'],
      periodsByFrequency: { weekly: 4 }, retirementCapPeriodsByFrequency: { weekly: 4 } }, 'fortnightly');
    expect(ytd.periods).toBeCloseTo(2, 10);
    expect(ytd.retirementCapPeriods).toBeCloseTo(2, 10);
    expect(warnings.map((w) => [w.code, w.severity])).toEqual([[PAY_FREQUENCY_CHANGED, 'warning']]);
    expect(warnings[0]!.message).toMatch(/weekly/);
    expect(warnings[0]!.message).toMatch(/UNVERIFIED/);
    expect(warnings[0]!.message).toMatch(/G21/);
  });

  it('two fortnights are four weeks; a month is 52 / F weeks for n, 52 / 12 for the cap', () => {
    expect(ytdInFrequency({ ...base, periodsByFrequency: { fortnightly: 2 }, retirementCapPeriodsByFrequency: { fortnightly: 2 } },
      'weekly').ytd.periods).toBeCloseTo(4, 10);
    const m = ytdInFrequency({ ...base, periodsByFrequency: { monthly: 1 }, retirementCapPeriodsByFrequency: { monthly: 1 } }, 'weekly').ytd;
    expect(m.periods).toBeCloseTo(52 / F_MONTH, 10);
    expect(m.retirementCapPeriods).toBeCloseTo(52 / 12, 10);
  });

  it('a mixed year sums each frequency in the current one (a starter share kept)', () => {
    const { ytd } = ytdInFrequency({ ...base, periodsByFrequency: { weekly: 3.4285, fortnightly: 1 },
      retirementCapPeriodsByFrequency: { weekly: 3.4285, fortnightly: 2 } }, 'fortnightly');
    expect(ytd.periods).toBeCloseTo(3.4285 / 2 + 1, 10);
    expect(ytd.retirementCapPeriods).toBeCloseTo(3.4285 / 2 + 2, 10);
  });

  it('one frequency, or no breakdown (a hand-built year to date), is returned unchanged and unwarned', () => {
    const same = { ...base, periodsByFrequency: { weekly: 4 }, retirementCapPeriodsByFrequency: { weekly: 4 } };
    expect(ytdInFrequency(same, 'weekly')).toEqual({ ytd: same, warnings: [] });
    expect(ytdInFrequency(base, 'fortnightly')).toEqual({ ytd: base, warnings: [] });
    // A zero bucket of another frequency is no change of frequency.
    const zero = { ...base, periodsByFrequency: { weekly: 4, monthly: 0 }, retirementCapPeriodsByFrequency: { weekly: 4, monthly: 0 } };
    expect(ytdInFrequency(zero, 'weekly').warnings).toEqual([]);
  });

  it('a cap-only period of another frequency (a bonus-only month) is converted too', () => {
    const { ytd, warnings } = ytdInFrequency({ ...base, periods: 4,
      periodsByFrequency: { weekly: 4 }, retirementCapPeriodsByFrequency: { weekly: 4, monthly: 1 } }, 'weekly');
    expect(ytd.periods).toBe(4);
    expect(ytd.retirementCapPeriods).toBeCloseTo(4 + 52 / 12, 10);
    expect(warnings).toHaveLength(1);
  });
});

describe('the engine counts the year in the current frequency (version 23)', () => {
  const oracle = (id: string) => loadCases().find((c) => c.id === id)!;
  it.each([
    ['frequency-change-weekly-to-fortnightly', 2783.71],
    ['frequency-change-fortnightly-to-weekly', 1391.87],
    ['frequency-change-monthly-to-weekly', 1701.87],
  ])('%s: PAYE %s, warned', (id, paye) => {
    const got = runCase(oracle(id));
    expect(got.paye).toBe(paye);
    expect(got.warnings).toContain(PAY_FREQUENCY_CHANGED);
  });

  it('the W53 mixed-year skip is lifted: a fortnight then 51 weeks is 53 weeks, the 53rd pay day warns (n counted in weeks)', () => {
    const c53 = oracle('weekly-week-53-pay-sunday');
    const [first, , ...rest] = c53.input.priorPeriods!;
    const changed = { ...c53, input: { ...c53.input, priorPeriods: [{ ...first!, frequency: 'fortnightly' as const }, ...rest] } };
    expect(runCase(changed).warnings).toEqual(expect.arrayContaining(['WEEK_53_PAY_DAY', PAY_FREQUENCY_CHANGED]));
    // One week fewer (52 weeks' worth): no 53rd pay day.
    const fewer = { ...changed, input: { ...changed.input, priorPeriods: changed.input.priorPeriods!.filter((_, i) => i !== 1) } };
    expect(runCase(fewer).warnings).not.toContain('WEEK_53_PAY_DAY');
  });

  it('a line off the tables (an independent contractor) takes no conversion and no warning', () => {
    const c = oracle('frequency-change-weekly-to-fortnightly');
    const contractor = { ...c, input: { ...c.input, employee: { ...c.input.employee, taxStatus: 'independent_contractor' } } };
    expect(runCase(contractor as typeof c).warnings).not.toContain(PAY_FREQUENCY_CHANGED);
  });
});
