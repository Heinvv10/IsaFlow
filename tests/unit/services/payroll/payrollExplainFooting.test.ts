/**
 * EX-core review round 1: explanations foot and recompute on lines no fixture holds. A seeded fuzz of 3 000 lines
 * (ported from the adversarial reviewer's repro: negative pay, large bonuses, retirement contributions and reversals,
 * donations, medical fees, ages 22/68/78, contractors and directors, a year to date of 0-10 periods), and the concrete
 * lines the review named: a retirement deduction taken off a bonus, a donation larger than periodic pay, the SDL
 * threshold boundary, and the 65+/75+ rebates pinned to the SARS 2026/27 figures.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { calculateSDL, isSdlExempt } from '@/modules/accounting/services/payroll/sdlEngine';
import { withSdlCharge } from '@/modules/accounting/services/payroll/statutoryExplain';
import type { PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';
import { buildCaseInput, loadCases, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';
import { cents, expectRecomputes, footingProblems, recomputeSdl, stepsByKey } from './payrollExplainRecompute.helpers';

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const amt = (max: number) => Math.round(rnd() * max * 100) / 100;
const earning = (code: string, amount: number) => ({ code, name: code, type: 'earning' as const, amount, taxable: true, uif: true, sdl: true });
const deduction = (code: string, amount: number) => ({ code, name: code, type: 'deduction' as const, amount, taxable: true, uif: false, sdl: false });

function mk(over: {
  dob: string; components: OracleCase['input']['components']; medical?: [boolean, number]; receipt?: boolean; month?: number;
  status?: string; uifEx?: boolean; est?: number;
}, ytd?: PayrollLineInput['ytd']): PayrollLineInput {
  const month = over.month ?? 3;
  const c: OracleCase = {
    id: 'fuzz', source: 'engine', sourceRef: 'n/a', notes: '',
    input: {
      period: { year: month >= 3 ? 2026 : 2027, month }, taxYear: 2027,
      employee: {
        dateOfBirth: over.dob, startDate: '2020-03-01', taxStatus: over.status ?? 'statutory', uifExcluded: over.uifEx ?? false,
        medicalAidMainMember: over.medical?.[0] ?? false, medicalAidDependantsCount: over.medical?.[1] ?? 0, s18aReceiptHeld: over.receipt ?? false,
      },
      employerAnnualRemuneration: over.est ?? 2_000_000, components: over.components,
    },
    expected: {},
  };
  return { ...buildCaseInput(c), ...(ytd ? { ytd } : {}) };
}

function randomInput(): PayrollLineInput {
  const comps: OracleCase['input']['components'] = [earning('3601', pick([0, amt(8000), amt(40000), amt(200000), -amt(5000)]))];
  if (rnd() < 0.5) comps.push(earning('3605', pick([amt(50000), amt(600000), -amt(20000)])));
  if (rnd() < 0.5) comps.push(deduction(pick(['4001', '4003', '4006']), pick([amt(3000), amt(30000), -amt(2000)])));
  if (rnd() < 0.3) comps.push(deduction('4030', amt(5000)));
  if (rnd() < 0.3) comps.push(deduction('4005', amt(8000)));
  const n = Math.floor(rnd() * 11);
  const ytd = rnd() < 0.6 ? {
    periods: n, retirementCapPeriods: n, periodicTaxable: amt(40000) * n, annualPayments: pick([0, amt(100000)]), tablePaye: amt(9000) * n,
    medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: pick([0, amt(5000) * n]), retirementContributions: pick([0, amt(5000) * n]),
    retirementDeduction: 0, donations: 0, donationDeduction: 0, sdlApplicable: amt(40000) * n, sdlLeviable: amt(30000) * n, sdlRetirementDeduction: 0,
  } : undefined;
  return mk({
    dob: pick(['1990-01-01', '1958-06-01', '1948-01-01', '2004-01-01']), components: comps,
    medical: pick([[false, 0], [true, 0], [true, 3]] as Array<[boolean, number]>), receipt: rnd() < 0.5, month: pick([3, 7, 12, 2]),
    status: pick(['statutory', 'statutory', 'independent_contractor', 'director']), uifEx: rnd() < 0.1, est: pick([300_000, 2_000_000]),
  }, ytd);
}

const amountOf = (line: ReturnType<typeof calculatePayrollLine>, key: string) =>
  stepsByKey(line.explanations.paye).get(key)?.amount;

describe('a seeded fuzz of 3 000 lines', () => {
  it('every explanation foots and recomputes its line to the cent', () => {
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const input = randomInput();
      let line: ReturnType<typeof calculatePayrollLine>;
      try { line = calculatePayrollLine(input); } catch { continue; } // the engine refuses some hand-built years to date; not an explanation
      expectRecomputes(line);
      checked++;
    }
    expect(checked).toBeGreaterThan(2500);
  });
});

describe('the lines the review named', () => {
  it('R5 000 salary, R500 000 bonus, R20 000 RA: the deduction off the bonus is shown and the annual payments foot', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', components: [earning('3601', 5000), earning('3605', 500000), deduction('4006', 20000)] }));
    expect(amountOf(l, 'paye.annualPayments')).toBeLessThan(500_000);
    expect(amountOf(l, 'paye.offAnnual')).toBeLessThan(0);
    expect(amountOf(l, 'paye.retirement.recorded')).toBe(l.retirementDeduction);
    expect(footingProblems(l.explanations.paye)).toEqual([]);
    expectRecomputes(l);
  });

  it('the reviewer\'s line: R2 000 salary, R300 000 bonus, R100 000 RA (Feb 2027): the step shows the lesser of the allowed R89 100 and the AE', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', month: 2, components: [earning('3601', 2000), earning('3605', 300_000), deduction('4006', 100_000)] }));
    const m = stepsByKey(l.explanations.paye);
    expect(m.get('paye.retirement.allowed')!.amount).toBeCloseTo(89_100, 6); // 27.5% of (24 000 + 300 000)
    expect(m.get('paye.retirement.rateLimit')!.amount).toBeCloseTo(89_100, 6);
    expect(m.get('paye.retirement')!.amount).toBeCloseTo(24_000, 6); // the annual equivalent binds
    expect(m.get('paye.retirement.ceiling')!.amount).toBeCloseTo(24_000, 6);
    expectRecomputes(l);
  });

  it('a bonus-only month does not count as a period paid, and says so', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', components: [earning('3605', 50_000)] }, {
      periods: 2, retirementCapPeriods: 2, periodicTaxable: 40_000, annualPayments: 0, tablePaye: 6_000, medicalCredit: 0,
      additionalMedicalCredit: 0, medicalSchemeFees: 0, sdlApplicable: 40_000, sdlLeviable: 40_000, sdlRetirementDeduction: 0,
    }));
    const periods = stepsByKey(l.explanations.paye).get('paye.periods')!;
    expect([periods.amount, periods.label]).toEqual([2, 'Periods paid (this period has no periodic pay, so it does not count)']);
    expectRecomputes(l);
  });

  it('taxable periodic pay lists each taxable earning, non-cash marked, and a clawback', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', components: [earning('3601', 20_000), earning('3606', 1_500), earning('3605', -2_000), { ...earning('3713', 900), taxable: false }] }));
    const m = stepsByKey(l.explanations.paye);
    const parts = m.get('paye.periodicBeforeDonation')!.children!.map(c => [c.label, c.amount]);
    expect(parts).toEqual([['3601 (3601)', 20_000], ['3606 (3606)', 1_500], ['Less a negative annual payment (a bonus clawback)', -2_000]]);
    expectRecomputes(l);
  });

  it('a non-cash benefit (3801) is listed and marked as one', () => {
    const input = mk({ dob: '1990-01-01', components: [earning('3601', 20_000), earning('3801', 750)] });
    input.components[1] = { ...input.components[1]!, isNonCash: true };
    const l = calculatePayrollLine(input);
    const parts = stepsByKey(l.explanations.paye).get('paye.periodicBeforeDonation')!.children!.map(c => c.label);
    expect(parts).toEqual(['3601 (3601)', '3801 (3801), a non-cash benefit']);
    expectRecomputes(l);
  });

  it('the ceiling is the annual equivalent plus periodic donations a year, not the annual equivalent alone', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', month: 4, receipt: true, components: [earning('3601', 20_000), deduction('4006', 30_000)] }, {
      periods: 1, retirementCapPeriods: 1, periodicTaxable: 20_000, annualPayments: 0, tablePaye: 2_000, medicalCredit: 0, additionalMedicalCredit: 0,
      medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0, donations: 2_000, donationDeduction: 2_000,
      sdlApplicable: 20_000, sdlLeviable: 20_000, sdlRetirementDeduction: 2_000,
      donationReceipted: 2_000, donationBase: 22_000, // the earlier donation, receipted
    }));
    const m = stepsByKey(l.explanations.paye);
    const ae = m.get('paye.annualEquivalent')!.amount!;
    // + the periodic donations to date (the earlier R2 000 and this line's signed deduction) x 12 / 2
    expect(m.get('paye.retirement.ceiling')!.amount).toBeCloseTo(ae + ((2_000 + l.donationDeduction) * 12) / 2, 6);
    expect(m.get('paye.retirement.ceiling')!.amount).toBeGreaterThan(ae + 1);
    expectRecomputes(l);
  });

  it('an earlier donation the year to date no longer allows is taken back, shown as a plus, and taxable pay foots', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', month: 4, receipt: true, components: [earning('3601', 20_000)] }, {
      periods: 1, retirementCapPeriods: 1, periodicTaxable: 20_000, annualPayments: 0, tablePaye: 2_000, medicalCredit: 0, additionalMedicalCredit: 0,
      medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0, donations: 2_000, donationDeduction: 2_000,
      sdlApplicable: 20_000, sdlLeviable: 20_000, sdlRetirementDeduction: 2_000,
    }));
    const m = stepsByKey(l.explanations.paye);
    const back = m.get('paye.donation')!;
    expect([back.amount, back.label]).toEqual([-l.donationDeduction, 'Plus an earlier s18A donation taken back (no longer allowed to date)']);
    expect(back.amount).toBeGreaterThan(0);
    expect(m.has('paye.regularTaxable.floor')).toBe(false);
    expectRecomputes(l);
  });

  it('non-standard employment with an RA: the flat 25% balance is taxable pay less the recorded deduction, and foots', () => {
    const base = loadCases().find(c => c.id === 'ts-non-standard-under-5h-day-flat-25pct')!;
    const withRa: OracleCase = { ...base, input: { ...base.input, components: [...base.input.components, deduction('4006', 500)] } };
    const l = calculatePayrollLine(buildCaseInput(withRa));
    const m = stepsByKey(l.explanations.paye);
    expect(l.retirementDeduction).toBeGreaterThan(0);
    expect(m.get('paye.balance.retirement')!.amount).toBe(-l.retirementDeduction);
    expect(footingProblems(l.explanations.paye)).toEqual([]);
    expectRecomputes(l);
  });

  it('a first period with no periodic pay takes the contributions as they stand, and says so', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', components: [earning('3605', 100_000), deduction('4006', 5_000)] }));
    const step = stepsByKey(l.explanations.paye).get('paye.retirement.annualised')!;
    expect([step.amount, step.formula]).toEqual([5_000, 'no periodic pay yet: taken as it stands']);
    expectRecomputes(l);
  });

  it('FB and ET on master: a 3701 at its 80% share in PAYE, UIF and SDL; the 3810 deemed fees; ETI by hours', () => {
    const byId = (id: string) => calculatePayrollLine(buildCaseInput(loadCases().find(c => c.id === id)!));
    const steps = (l: ReturnType<typeof calculatePayrollLine>, fig: 'paye' | 'uif' | 'sdl' | 'eti') => [...stepsByKey(l.explanations[fig]).values()];

    const travel = byId('fb-travel-3701-80pct-taxed');
    // The fixture's 3701 is taxable and SDL-applicable, not UIF-applicable (as a travel allowance is set up).
    for (const [fig, want] of [['paye', [0.8]], ['sdl', [0.8]], ['uif', []]] as const) {
      const shares = steps(travel, fig).filter(s => s.key.endsWith('.share')).map(s => s.amount);
      expect(shares, fig).toEqual(want);
    }
    expect(stepsByKey(travel.explanations.paye).get('paye.periodic.1')!.amount).toBe(4000);
    expectRecomputes(travel);

    const medical = byId('fb-medical-3810-employer-contribution-taxable');
    const m = stepsByKey(medical.explanations.paye);
    expect(m.get('paye.medicalFees.employer')!.amount).toBeGreaterThan(0);
    expect(footingProblems(medical.explanations.paye)).toEqual([]);
    expectRecomputes(medical);

    const hourly = byId('eti-year1-120h-5000-apportioned');
    const e = stepsByKey(hourly.explanations.eti);
    expect([e.get('eti.hours')!.amount, e.get('eti.share')!.amount, hourly.eti.monthlyEti]).toEqual([120, 0.75, 468.75]);
    expect(e.get('eti.tabled')!.amount).toBeCloseTo(5000 * 160 / 120, 6);
    expectRecomputes(hourly);
  });

  it('the cap to date binds what comes off the bonus: R5 000 salary, R2 000 000 bonus, R100 000 RA, first month', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', components: [earning('3601', 5000), earning('3605', 2_000_000), deduction('4006', 100_000)] }));
    const m = stepsByKey(l.explanations.paye);
    const capLeft = m.get('paye.offAnnual.capLeft')!.amount!;
    expect(capLeft).toBeCloseTo(430_000 / 12 - 5000, 6); // the 2026/27 cap for one period, less the R5 000 off periodic pay
    expect(-m.get('paye.offAnnual')!.amount!).toBeCloseTo(capLeft, 6);
    expectRecomputes(l);
  });

  it('a donation beside a bonus: the donation shown is the one allowed (no more than periodic pay), and the bonus foots', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', receipt: true, components: [earning('3601', 2000), earning('3605', 100000), deduction('4030', 4000)] }));
    expect(amountOf(l, 'paye.donation')).toBe(-l.donationDeduction);
    expect(amountOf(l, 'paye.annualNow.paid')).toBe(100_000);
    expect(amountOf(l, 'paye.annualPayments')).toBe(100_000 - (-(amountOf(l, 'paye.annualNow.donation') ?? 0)));
    expectRecomputes(l);
  });

  it('negative periodic pay: taxable pay shows a "Not below nil" part', () => {
    const l = calculatePayrollLine(mk({ dob: '1990-01-01', components: [earning('3601', -3000), earning('3605', 20000)] }));
    expect(amountOf(l, 'paye.regularTaxable')).toBe(0);
    expect(amountOf(l, 'paye.regularTaxable.floor')).toBe(3000);
    expectRecomputes(l);
  });

  it('SDL at the threshold is exempt and one rand over is liable', () => {
    const l = calculatePayrollLine({ ...mk({ dob: '1990-01-01', components: [earning('3601', 20000)] }), annualPayrollEstimate: 'defer' });
    for (const [estimate, exempt] of [[500_000, true], [500_001, false]] as const) {
      expect(isSdlExempt(estimate, 2027)).toBe(exempt);
      const sdl = calculateSDL(l.sdlLeviable, estimate, 2027);
      const done = withSdlCharge(l.explanations.sdl, 2027, { annualRemuneration: estimate, exempt, sdl });
      expect(cents(recomputeSdl(done))).toBe(cents(sdl));
      expect(cents(sdl)).toBe(exempt ? 0 : 20_000);
    }
  });

  it('rebates are the SARS 2026/27 figures: R17 820, + R9 765 at 65, + R3 249 at 75', () => {
    const rebates = (dob: string) => stepsByKey(calculatePayrollLine(mk({ dob, components: [earning('3601', 30000)] })).explanations.paye).get('paye.atAE.rebates')!.amount;
    expect([rebates('1990-01-01'), rebates('1958-06-01'), rebates('1948-01-01')]).toEqual([17_820, 27_585, 30_834]);
  });
});
