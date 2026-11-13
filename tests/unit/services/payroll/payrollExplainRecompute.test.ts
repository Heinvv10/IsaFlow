/**
 * EX-core (wave 5 spec §4): a line's explanation must recompute the line's stored result to the cent, for every
 * oracle case and for lines the oracle has none of (a year to date, 65+ and 75+ rebates with medical credits, a
 * retirement contribution with a bonus, a donation, a deferred SDL charge).
 *
 * The recompute here is independent of the engine: it reads only the explanation's steps (by key) and applies the
 * statutory arithmetic the steps state: bracket base + rate x (income - lower), less the rebates and credits, the
 * cumulative liability, the UIF ceiling, the SDL year to date and the ETI table. A step the explainer reports wrongly
 * (e.g. the rebate before the 65+ addition) makes the recompute miss the stored figure.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { calculateSDL, isSdlExempt } from '@/modules/accounting/services/payroll/sdlEngine';
import { withSdlCharge } from '@/modules/accounting/services/payroll/statutoryExplain';
import type { PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';
import { buildCaseInput, loadCases, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';
import { cents, expectRecomputes, recomputeSdl } from './payrollExplainRecompute.helpers';

const cases = loadCases();

describe('every oracle case: the explanation recomputes PAYE, UIF, SDL and ETI to the cent', () => {
  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    expectRecomputes(calculatePayrollLine(buildCaseInput(c)));
  });
});

/** A synthetic line from an oracle-shaped case, with an optional year to date. */
function line(over: { dob?: string; components: OracleCase['input']['components']; medical?: [boolean, number]; receipt?: boolean; month?: number }, ytd?: PayrollLineInput['ytd']) {
  const c: OracleCase = {
    id: 'synthetic', source: 'engine', sourceRef: 'n/a', notes: '',
    input: {
      period: { year: 2026, month: over.month ?? 3 }, taxYear: 2027,
      employee: {
        dateOfBirth: over.dob ?? '1986-01-01', startDate: '2020-03-01', taxStatus: 'statutory', uifExcluded: false,
        medicalAidMainMember: over.medical?.[0] ?? false, medicalAidDependantsCount: over.medical?.[1] ?? 0, s18aReceiptHeld: over.receipt ?? false,
      },
      employerAnnualRemuneration: 2_000_000,
      components: over.components,
    },
    expected: {},
  };
  return { ...buildCaseInput(c), ...(ytd ? { ytd } : {}) };
}
const earning = (code: string, amount: number) => ({ code, name: code, type: 'earning' as const, amount, taxable: true, uif: true, sdl: true });
const deduction = (code: string, amount: number) => ({ code, name: code, type: 'deduction' as const, amount, taxable: true, uif: false, sdl: false });

describe('lines the oracle does not cover recompute too', () => {
  it('65 and older with medical aid: secondary rebate, MTC and the additional credit', () => {
    const l = calculatePayrollLine(line({ dob: '1955-06-01', medical: [true, 1], components: [earning('3601', 30_000), deduction('4005', 6_000)] }));
    expect(l.explanations.paye.steps.flatMap(s => s.children ?? []).some(s => s.key === 'paye.atAE.rebates')).toBe(true);
    expect(l.paye.monthlyPaye).toBeGreaterThan(0);
    expectRecomputes(l);
  });

  it('75 and older: the tertiary rebate', () => {
    expectRecomputes(calculatePayrollLine(line({ dob: '1948-01-01', components: [earning('3601', 25_000)] })));
  });

  it('a second period with a year to date, a retirement annuity and a bonus on top of an earlier one', () => {
    const l = calculatePayrollLine(line({ month: 4, components: [earning('3601', 32_000), earning('3605', 5_000), deduction('4006', 3_000)] }, {
      periods: 1, retirementCapPeriods: 1, periodicTaxable: 30_000, annualPayments: 10_000, tablePaye: 7_100,
      medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 3_000, retirementDeduction: 3_000,
      sdlApplicable: 40_000, sdlLeviable: 37_000, sdlRetirementDeduction: 3_000,
    }));
    expect(l.explanations.paye.steps.some(s => s.key === 'paye.atEarlier')).toBe(true);
    expectRecomputes(l);
  });

  it('an s18A donation with a receipt', () => {
    expectRecomputes(calculatePayrollLine(line({ receipt: true, components: [earning('3601', 40_000), deduction('4030', 1_000)] })));
  });

  it('a run line costed with SDL deferred, completed by the run\'s threshold decision', () => {
    const l = calculatePayrollLine({ ...line({ components: [earning('3601', 20_000)] }), annualPayrollEstimate: 'defer' });
    for (const estimate of [400_000, 900_000]) {
      const sdl = calculateSDL(l.sdlLeviable, estimate, 2027);
      const done = withSdlCharge(l.explanations.sdl, 2027, { annualRemuneration: estimate, exempt: isSdlExempt(estimate, 2027), sdl });
      expect(cents(recomputeSdl(done))).toBe(cents(sdl));
      expect(done.result).toBe(sdl);
    }
  });

  // DR: a regular-pay directive's steps recompute the line too (the rate on a bonus, a clawback, a fixed amount capped at the cash).
  const window = { endsOn: '2027-02-28', effectiveDate: '2026-03-01', number: '1234567', id: 'd' };
  const pct20 = { ...window, type: 'fixed_percentage' as const, rate: 0.2, fixedAmount: null };
  const fixed = (fixedAmount: number) => ({ ...window, type: 'fixed_amount' as const, rate: null, fixedAmount });
  it.each([
    ['20% with a 3605 bonus', [earning('3601', 30_000), earning('3605', 10_000)], pct20],
    ['20% with a 3605 clawback', [earning('3601', 30_000), earning('3605', -5_000)], pct20],
    ['fixed R2 500 with a 3605 bonus', [earning('3601', 30_000), earning('3605', 10_000)], fixed(2_500)],
    ['fixed R2 500 capped on a R1 000 month', [earning('3601', 1_000)], fixed(2_500)],
  ] as const)('a directive: %s', (_n, components, current) => {
    const l = calculatePayrollLine({ ...line({ components: [...components] }), regularPayDirective: { current, ended: null } });
    expect(l.explanations.paye.steps.some(s => s.key === 'paye.regularDirective.regular')).toBe(true);
    expectRecomputes(l);
  });
});
