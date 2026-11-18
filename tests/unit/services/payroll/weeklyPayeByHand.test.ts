import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCaseInput } from '../../../fixtures/payroll-oracle/oracleInput';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayeYearToDate } from '@/modules/accounting/services/payroll/payrollTypes';
import { dayNumber, isoOfDay } from '@/modules/accounting/services/payroll/payFrequencyPeriods';

const base = JSON.parse(readFileSync('tests/fixtures/payroll-oracle/weekly-week-53-pay-sunday.json', 'utf8'));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Run weeks sequentially (week Mon-Sun paid Sunday; week 1 = 23 Feb-1 Mar 2026), feeding the engine's own ytd. */
function year(opts: { weekly: number; weeks: number; medical?: { fees: number; deps: number }; startDate?: string; endDate?: string; firstWeek?: number }) {
  const ytd: PayeYearToDate = { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0,
    medicalSchemeFees: 0, retirementCapPeriods: 0, sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0 } as PayeYearToDate;
  const out: Array<{ wk: number; start: string; paye: number; mtc: number; n: number; ae: number }> = [];
  for (let w = opts.firstWeek ?? 1; w <= opts.weeks; w++) {
    const start = isoOfDay(dayNumber('2026-02-23') + 7 * (w - 1));
    const end = isoOfDay(dayNumber(start) + 6);
    const c = structuredClone(base);
    c.input.priorPeriods = undefined;
    c.input.period = { ...c.input.period, year: Number(end.slice(0, 4)), month: Number(end.slice(5, 7)), periodStart: start, periodEnd: end };
    if (opts.startDate) c.input.employee.startDate = opts.startDate;
    if (opts.endDate) c.input.employee.endDate = opts.endDate;
    c.input.components = [{ ...c.input.components[0], amount: opts.weekly }];
    if (opts.medical) {
      c.input.employee.medicalAidMainMember = true; c.input.employee.medicalAidDependantsCount = opts.medical.deps;
      c.input.components.push({ code: '4005', name: 'Medical aid', type: 'deduction', amount: opts.medical.fees, taxable: false, uif: false, sdl: false });
    }
    const input = buildCaseInput(c);
    input.ytd = { ...ytd };
    const r = calculatePayrollLine(input);
    const tr = (r as unknown as { explain?: unknown });
    void tr;
    const n = (input.cadence ? ytd.periods : 0);
    ytd.periods += r.periodicTaxable > 0 ? (r as never as { _s?: number })._s ?? shareOf(input) : 0;
    ytd.retirementCapPeriods = (ytd.retirementCapPeriods ?? 0) + (r.periodicTaxable > 0 ? shareOf(input) : 0);
    ytd.periodicTaxable = round2(ytd.periodicTaxable + r.periodicTaxable);
    ytd.tablePaye = round2(ytd.tablePaye + r.paye.monthlyPaye);
    ytd.medicalCredit = round2(ytd.medicalCredit + r.medicalCredit);
    ytd.sdlApplicable = round2((ytd.sdlApplicable ?? 0) + r.sdlApplicable); ytd.sdlLeviable = round2((ytd.sdlLeviable ?? 0) + r.sdlLeviable);
    ytd.medicalSchemeFees = round2(ytd.medicalSchemeFees + r.medicalSchemeFees);
    out.push({ wk: w, start, paye: r.paye.monthlyPaye, mtc: r.medicalCredit, n: n + shareOf(input), ae: r.paye.annualTaxableIncome });
  }
  return { out, ytd };
}
import { periodShareOf } from '@/modules/accounting/services/payroll/payFrequencyPeriods';
function shareOf(input: ReturnType<typeof buildCaseInput>) {
  return periodShareOf('weekly', { start: input.cadence!.periodStart, end: input.cadence!.periodEnd }, input.employee.startDate, input.employee.endDate);
}

describe('rev1575 weekly PAYE by hand', () => {
  it('52 weeks at R6 000: every week = (tax(312 000) - 17 820) / 52 = 840.23; year = 43 692', () => {
    // Hand: 312 000 in bracket 245 101-383 100: 44 118 + 26% x 66 900 = 61 512; less primary rebate 17 820 = 43 692.
    const { out, ytd } = year({ weekly: 6000, weeks: 52 });
    console.log('W52 first/last', out[0], out[51], 'sum', ytd.tablePaye);
    expect(out[0]!.paye).toBe(840.23);
    expect(ytd.tablePaye).toBeCloseTo(43692, 0);
  });
  it('week 53 at R6 000: SimplePay x52/n gives 840.23 again; true year liability on 318 000 is 45 252', () => {
    const { out, ytd } = year({ weekly: 6000, weeks: 53 });
    console.log('W53', out[52], 'sum', ytd.tablePaye, 'true', 44118 + 0.26 * (318000 - 245100) - 17820);
  });
  it('week 53 with medical aid (main + 1): MTC over the year vs the statutory 12 x 752 = 9 024', () => {
    const r52 = year({ weekly: 6000, weeks: 52, medical: { fees: 1000, deps: 1 } });
    const r53 = year({ weekly: 6000, weeks: 53, medical: { fees: 1000, deps: 1 } });
    console.log('MTC 52wk', r52.ytd.medicalCredit, 'paye', r52.ytd.tablePaye, '| 53wk', r53.ytd.medicalCredit, 'paye', r53.ytd.tablePaye, 'wk53', r53.out[52]);
    // s6A: R376 a month main + first dependant each => 752 x 12 = 9 024 for the year of assessment (12 months, however many pay days).
    expect(r53.ytd.medicalCredit).toBeLessThanOrEqual(9024);
  });
  it('mid-year starter (Wed 3 Jun 2026, week 1 Mon 1-Sun 7 Jun = 5 of 7 days)', () => {
    // week index of 1 Jun 2026: (dayNumber(2026-06-01) - dayNumber(2026-02-23))/7 + 1
    const first = (dayNumber('2026-06-01') - dayNumber('2026-02-23')) / 7 + 1;
    const { out } = year({ weekly: 6000, weeks: first + 1, firstWeek: first, startDate: '2026-06-03' });
    console.log('starter', out);
  });
  it('leaver final week (end Tue 9 Jun: 2 of 7 days)', () => {
    const { out } = year({ weekly: 6000, weeks: 15, endDate: '2026-06-09' });
    console.log('leaver last two', out.slice(-2));
  });
});
