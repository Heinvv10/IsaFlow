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
import { buildCaseInput, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';
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
