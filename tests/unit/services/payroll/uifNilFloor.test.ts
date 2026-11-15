/**
 * UF (wave 6): UIF is never negative. A clawback larger than the month's UIF-applicable pay leaves the leviable base
 * below nil; the contribution is then nil for employee and employer, not a negative contribution.
 *
 * Source: Unemployment Insurance Contributions Act 4 of 2002, s6(1)(a) and (b) (Government Gazette 23289,
 * 28 March 2002, p. 7): each contribution "must be one per cent of the remuneration paid or payable ... during any
 * month"; s6(2) (p. 8): s6(1) "does not apply to so much of the remuneration ... as exceeds" the Minister's ceiling.
 * The Act provides a contribution on remuneration paid, and no negative contribution or refund through it.
 */
import { describe, expect, it } from 'vitest';
import { uifWithLeviable } from '@/modules/accounting/services/payroll/uifEngine';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { uifLineBase, UIF_MONTHLY_CEILING } from '@/modules/accounting/services/payroll/uifLeviableBase';
import { buildCaseInput, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';
import { expectRecomputes, footingProblems, stepsByKey } from './payrollExplainRecompute.helpers';

const CEILING = 17_712;

describe('uifWithLeviable floors the leviable base at nil [UIC Act 4 of 2002 s6(1), s6(2)]', () => {
  it.each([
    [-100, 0, 0, false],
    [0, 0, 0, false],
    [CEILING, CEILING, 177.12, false],
    [CEILING + 1, CEILING, 177.12, true],
  ])('pay %d → leviable %d, R%d each, capped %s', (pay, leviable, each, capped) => {
    const r = uifWithLeviable(pay, 2027);
    expect(r.leviable).toBe(leviable);
    expect([r.uif.employeeContribution, r.uif.employerContribution, r.uif.isCapped]).toEqual([each, each, capped]);
  });

  it('a clawback of R250 000 still gives nil, not -R2 500', () => {
    expect(uifWithLeviable(-250_000, 2026).uif).toEqual({ employeeContribution: 0, employerContribution: 0, isCapped: false });
  });
});

function line(components: OracleCase['input']['components']) {
  const c: OracleCase = {
    id: 'uf-clawback', source: 'engine', sourceRef: 'n/a', notes: '',
    input: {
      period: { year: 2026, month: 6 }, taxYear: 2027,
      employee: {
        dateOfBirth: '1990-01-01', startDate: '2020-03-01', taxStatus: 'statutory', uifExcluded: false,
        medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false,
      },
      employerAnnualRemuneration: 2_000_000, components,
    },
    expected: {},
  };
  return calculatePayrollLine(buildCaseInput(c));
}
const earning = (code: string, amount: number, uif = true) => ({ code, name: code, type: 'earning' as const, amount, taxable: true, uif, sdl: true });

describe('a clawback line: UIF nil, and the explanation shows the floor', () => {
  it('UIF pay R5 000 with a R8 000 clawback (and R10 000 not UIF-applicable): UIF 0 / 0, net pay is not raised by a negative UIF', () => {
    const l = line([earning('3601', 5_000), earning('3601', -8_000), earning('3601', 10_000, false)]);
    expect(l.grossPay).toBe(7_000);
    expect([l.uif.employeeContribution, l.uif.employerContribution, l.uif.isCapped]).toEqual([0, 0, false]);
    expect(l.netPay).toBe(l.grossPay - l.paye.monthlyPaye);
  });

  it('the "Pay the contribution is on" step is nil with a "Not below nil" part of R3 000, and the explanation foots and recomputes', () => {
    const l = line([earning('3601', 5_000), earning('3601', -8_000)]);
    const steps = stepsByKey(l.explanations.uif);
    expect(steps.get('uif.remuneration')!.amount).toBe(-3_000);
    expect(steps.get('uif.leviable')!.amount).toBe(0);
    expect(steps.get('uif.leviable.floor')).toMatchObject({ label: 'Not below nil', amount: 3_000 });
    expect(footingProblems(l.explanations.uif)).toEqual([]);
    expectRecomputes(l);
  });

  it('ordinary pay keeps the plain step (no floor part)', () => {
    const steps = stepsByKey(line([earning('3601', 10_000)]).explanations.uif);
    expect(steps.get('uif.leviable')!.amount).toBe(10_000);
    expect(steps.has('uif.leviable.floor')).toBe(false);
  });
});

describe('the UI-19 line view gets the same floor (uifLineBase)', () => {
  it('a rebuilt base below nil: leviable salary nil, matched exactly against a nil stored contribution', () => {
    expect(uifLineBase(-3_000, 0, -3_000)).toEqual({ leviableSalary: 0, isCapped: false, exact: true });
  });

  it('a line stored negative before UF (contribution -R30) is not trusted, and its leviable salary is not shown below nil', () => {
    expect(uifLineBase(-3_000, -30, -3_000)).toEqual({ leviableSalary: 0, isCapped: false, exact: false });
  });

  it('the ceiling and ceiling + 1 are unchanged', () => {
    expect(uifLineBase(UIF_MONTHLY_CEILING, 177.12, UIF_MONTHLY_CEILING)).toEqual({ leviableSalary: UIF_MONTHLY_CEILING, isCapped: false, exact: true });
    expect(uifLineBase(UIF_MONTHLY_CEILING + 1, 177.12, UIF_MONTHLY_CEILING + 1)).toEqual({ leviableSalary: UIF_MONTHLY_CEILING, isCapped: true, exact: true });
  });
});
