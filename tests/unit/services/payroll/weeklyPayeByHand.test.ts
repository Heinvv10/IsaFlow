/**
 * Weekly PAYE against figures derived by hand (review #1575, the payroll breaker's check, made exact).
 * Each week is costed by calculatePayrollLine on the week-53 oracle case's employee (under 65, week Monday to Sunday,
 * paid on the Sunday; week 1 = 23 Feb - 1 Mar 2026), feeding the engine's own lines back in as the year to date.
 * Hand method (2027 tables, primary rebate R17 820; G21 p. 8 with ruling 16's x 52): n = the weeks worked (a part week
 * by its days, truncated to four decimals), AE = pay to date x 52 / n, the year's tax = table(AE) - rebate, the
 * liability to date = that x n / 52, and a week's PAYE = the liability to date less the earlier weeks' PAYE.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCaseInput } from '../../../fixtures/payroll-oracle/oracleInput';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { dayNumber, isoOfDay, periodShareOf } from '@/modules/accounting/services/payroll/payFrequencyPeriods';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';

const base = JSON.parse(readFileSync('tests/fixtures/payroll-oracle/weekly-week-53-pay-sunday.json', 'utf8'));
const round2 = (n: number) => Math.round(n * 100) / 100;

interface Year { weekly: number; firstWeek?: number; weeks: number; medical?: { fees: number; deps: number }; startDate?: string; endDate?: string }

/** Weeks `firstWeek`..`weeks` in order: each week's PAYE and medical credit, and the year to date after the last. */
function year(opts: Year) {
  const ytd: PayeYearToDate = {
    periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0,
    medicalSchemeFees: 0, retirementCapPeriods: 0, sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0,
  } as PayeYearToDate;
  const weeks: Array<{ paye: number; credit: number }> = [];
  for (let w = opts.firstWeek ?? 1; w <= opts.weeks; w++) {
    const start = isoOfDay(dayNumber('2026-02-23') + 7 * (w - 1));
    const end = isoOfDay(dayNumber(start) + 6);
    const c = structuredClone(base);
    c.input.priorPeriods = undefined;
    c.input.period = { ...c.input.period, year: Number(end.slice(0, 4)), month: Number(end.slice(5, 7)), periodStart: start, periodEnd: end };
    if (opts.startDate) c.input.employee.startDate = opts.startDate;
    c.input.components = [{ ...c.input.components[0], amount: opts.weekly }];
    if (opts.medical) {
      c.input.employee.medicalAidMainMember = true;
      c.input.employee.medicalAidDependantsCount = opts.medical.deps;
      c.input.components.push({ code: '4005', name: 'Medical aid', type: 'deduction', amount: opts.medical.fees, taxable: false, uif: false, sdl: false });
    }
    const input = buildCaseInput(c);
    // The oracle's employee has no end date field: a leaver is set on the built employee.
    if (opts.endDate) input.employee.endDate = new Date(`${opts.endDate}T00:00:00Z`);
    input.ytd = { ...ytd };
    const r = calculatePayrollLine(input);
    const share = periodShareOf('weekly', { start, end }, input.employee.startDate, input.employee.endDate);
    if (r.periodicTaxable > 0) {
      ytd.periods += share;
      ytd.retirementCapPeriods = (ytd.retirementCapPeriods ?? 0) + share;
    }
    ytd.periodicTaxable = round2(ytd.periodicTaxable + r.periodicTaxable);
    ytd.tablePaye = round2(ytd.tablePaye + r.paye.monthlyPaye);
    ytd.medicalCredit = round2(ytd.medicalCredit + r.medicalCredit);
    ytd.medicalSchemeFees = round2(ytd.medicalSchemeFees + r.medicalSchemeFees);
    ytd.sdlApplicable = round2((ytd.sdlApplicable ?? 0) + r.sdlApplicable);
    ytd.sdlLeviable = round2((ytd.sdlLeviable ?? 0) + r.sdlLeviable);
    weeks.push({ paye: r.paye.monthlyPaye, credit: r.medicalCredit });
  }
  return { weeks, ytd };
}

/** The first week of June 2026 (Monday 1 June) in the harness's numbering. */
const JUNE_WEEK = (dayNumber('2026-06-01') - dayNumber('2026-02-23')) / 7 + 1;

describe('weekly PAYE, derived by hand', () => {
  it('52 weeks at R6 000: every week (312 000: 44 118 + 26% x 66 900 = 61 512, less 17 820 = 43 692) / 52 = 840.23; the year 43 692', () => {
    const { weeks, ytd } = year({ weekly: 6000, weeks: 52 });
    expect(weeks[0]!.paye).toBe(840.23);
    expect(ytd.tablePaye).toBe(43692);
  });

  it('week 53 at R6 000: the AE stays 312 000, the liability to date 43 692 x 53 / 52 = 44 532.23, so week 53 = 840.23 (ruled: x 52 over n = 53)', () => {
    const { weeks, ytd } = year({ weekly: 6000, weeks: 53 });
    expect(weeks[52]!.paye).toBe(840.23);
    expect(ytd.tablePaye).toBe(44532.23);
  });

  it('week 53 with medical aid (main + 1): the year\'s s6A credit is exactly 12 x R752 = 9 024, and week 53 takes none', () => {
    const { weeks, ytd } = year({ weekly: 6000, weeks: 53, medical: { fees: 1000, deps: 1 } });
    expect(ytd.medicalCredit).toBe(9024);
    expect(weeks[52]!.credit).toBe(0);
  });

  it('a starter on Wednesday 3 June: week 1 counts 5 of 7 days (0.7142), AE 436 852.42, PAYE 1 082.85; week 2, n = 1.7142, AE 364 018.20, PAYE 803.32', () => {
    // Week 1: 6 000 x 52 / 0.7142 = 436 852.42; 79 998 + 31% x 53 752.42 = 96 661.25, less 17 820 = 78 841.25; x 0.7142 / 52 = 1 082.85.
    // Week 2: 12 000 x 52 / 1.7142 = 364 018.20; 44 118 + 26% x 118 918.20 = 75 036.73, less 17 820 = 57 216.73; x 1.7142 / 52 = 1 886.17 to date.
    const { weeks } = year({ weekly: 6000, firstWeek: JUNE_WEEK, weeks: JUNE_WEEK + 1, startDate: '2026-06-03' });
    expect(weeks.map((w) => w.paye)).toEqual([1082.85, 803.32]);
  });

  it('a leaver on Tuesday 9 June: the last week counts 2 of 7 days (0.2857), n = 15.2857, AE 326 579.74, PAYE 1 354.36', () => {
    // 96 000 x 52 / 15.2857 = 326 579.74; 44 118 + 26% x 81 479.74 = 65 302.73, less 17 820 = 47 482.73; x 15.2857 / 52 = 13 957.815
    // to date, less 15 weeks of 840.23 (12 603.45) = 1 354.36.
    const { weeks } = year({ weekly: 6000, weeks: 16, endDate: '2026-06-09' });
    expect(weeks.slice(-2).map((w) => w.paye)).toEqual([840.23, 1354.36]);
  });
});
