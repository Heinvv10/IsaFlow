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
import type { PayrollLineInput, PayrollLineResult } from '@/modules/accounting/services/payroll/payrollTypes';
import type { ExplainStep, FigureExplanation } from '@/modules/accounting/services/payroll/payrollExplainTypes';
import { buildCaseInput, loadCases, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);

function stepsByKey(fig: FigureExplanation): Map<string, ExplainStep> {
  const out = new Map<string, ExplainStep>();
  const walk = (steps: ExplainStep[]) => {
    for (const s of steps) {
      if (out.has(s.key)) throw new Error(`duplicate step key ${s.key}`);
      out.set(s.key, s);
      walk(s.children ?? []);
    }
  };
  walk(fig.steps);
  return out;
}

function reader(fig: FigureExplanation) {
  const m = stepsByKey(fig);
  const amt = (key: string): number => {
    const s = m.get(key);
    if (!s || s.amount === null) throw new Error(`${fig.figure}: no amount for step ${key}`);
    return s.amount;
  };
  return { has: (key: string) => m.has(key), amt };
}

/** Tax for a year from one tax block's steps: bracket, rebates (as their parts), credits. */
function taxFromBlock(r: ReturnType<typeof reader>, p: string): number {
  const income = r.amt(`${p}.income`);
  const gross = r.amt(`${p}.bracket.baseTax`) + r.amt(`${p}.bracket.rate`) * (income - r.amt(`${p}.bracket.lower`));
  const rebates = r.amt(`${p}.rebates`);
  expect(r.amt(`${p}.rebates.primary`) + r.amt(`${p}.rebates.secondary`) + r.amt(`${p}.rebates.tertiary`)).toBeCloseTo(rebates, 9);
  const mtc = r.has(`${p}.medicalCredits`) ? r.amt(`${p}.medicalCredits`) : 0;
  const amtc = r.has(`${p}.additionalMedicalCredits`) ? r.amt(`${p}.additionalMedicalCredits`) : 0;
  return Math.max(0, Math.max(0, Math.max(0, gross - rebates) - mtc) - amtc);
}

function recomputePaye(fig: FigureExplanation): number {
  const r = reader(fig);
  const directive = r.has('paye.directive') ? r.amt('paye.directive') : 0;
  let regular = 0;
  let annual = 0;
  if (r.has('paye.flat')) {
    regular = round2(r.amt('paye.flatRate') * Math.max(0, r.amt('paye.balance')));
  } else if (r.has('paye.annualEquivalent')) {
    const n = r.amt('paye.periods');
    const toDate = r.amt('paye.ytdPeriodicTaxable') + r.amt('paye.regularTaxable');
    const ae = (toDate * 12) / n;
    let off = 0;
    if (r.has('paye.retirement')) {
      const allowed = Math.max(0, Math.min(r.amt('paye.retirement.annualised'), r.amt('paye.retirement.rate') * r.amt('paye.retirement.base'), r.amt('paye.retirement.cap')));
      expect(r.amt('paye.retirement.allowed')).toBeCloseTo(allowed, 6);
      off = r.amt('paye.retirement');
      expect(off).toBeLessThanOrEqual(allowed + 1e-9);
    }
    const taxedAE = Math.max(0, ae - off);
    expect(r.amt('paye.atAE.income')).toBeCloseTo(taxedAE, 6);
    const taxAE = taxFromBlock(r, 'paye.atAE');
    let taxAll = taxAE;
    let taxEarlier = taxAE;
    if (r.has('paye.annualPayments')) {
      expect(r.amt('paye.atAll.income')).toBeCloseTo(taxedAE + r.amt('paye.annualPayments'), 6);
      taxAll = taxFromBlock(r, 'paye.atAll');
      if (r.has('paye.atEarlier')) {
        expect(r.amt('paye.atEarlier.income')).toBeCloseTo(taxedAE + r.amt('paye.annualEarlier'), 6);
        taxEarlier = taxFromBlock(r, 'paye.atEarlier');
      }
    }
    const liability = (taxAE * n) / 12 + (taxAll - taxAE);
    const due = Math.max(0, round2(liability - r.amt('paye.ytdTablePaye')));
    annual = round2(Math.min(due, Math.max(0, taxAll - taxEarlier)));
    regular = round2(due - annual);
  }
  return round2(regular + annual + directive);
}

function recomputeUif(fig: FigureExplanation): number {
  const r = reader(fig);
  if (r.has('uif.none')) return 0;
  const leviable = Math.min(r.amt('uif.remuneration'), r.amt('uif.ceiling'));
  const each = round2(leviable * r.amt('uif.rate'));
  expect(cents(r.amt('uif.employer'))).toBe(cents(each));
  return each;
}

function recomputeSdl(fig: FigureExplanation): number {
  const r = reader(fig);
  if (r.has('sdl.none')) return 0;
  const pay = r.amt('sdl.ytdApplicable') + r.amt('sdl.applicable');
  const deduction = r.amt('sdl.ytdDeduction') + r.amt('sdl.deduction');
  const toDate = Math.min(pay, Math.max(0, pay - deduction));
  const leviable = Math.max(0, round2(toDate - r.amt('sdl.carried')));
  const exempt = r.amt('sdl.annualRemuneration') <= r.amt('sdl.threshold');
  return exempt ? 0 : round2(leviable * r.amt('sdl.rate'));
}

function recomputeEti(fig: FigureExplanation): number {
  const r = reader(fig);
  if (r.has('eti.ineligible')) return 0;
  const rem = r.amt('eti.remuneration');
  const t = (k: string) => r.amt(`eti.table.${k}`);
  let yearOne: number;
  if (rem >= t('wageCeiling')) yearOne = 0;
  else if (rem < t('lowBandCeiling')) yearOne = t('lowBandRate') * rem;
  else if (rem < t('taperStart')) yearOne = t('maxMonthlyEti');
  else yearOne = t('maxMonthlyEti') - t('taperRate') * (rem - t('taperStart'));
  return round2(Math.max(0, r.amt('eti.employmentYear') === 1 ? yearOne : yearOne / 2));
}

function expectRecomputes(line: PayrollLineResult) {
  const e = line.explanations;
  expect({ paye: cents(recomputePaye(e.paye)), uif: cents(recomputeUif(e.uif)), sdl: cents(recomputeSdl(e.sdl)), eti: cents(recomputeEti(e.eti)) })
    .toEqual({ paye: cents(line.paye.monthlyPaye), uif: cents(line.uif.employeeContribution), sdl: cents(line.sdl), eti: cents(line.eti.monthlyEti) });
  expect(cents(e.paye.result)).toBe(cents(line.paye.monthlyPaye));
  expect(cents(e.uif.result)).toBe(cents(line.uif.employeeContribution));
  expect(cents(e.sdl.result)).toBe(cents(line.sdl));
  expect(cents(e.eti.result)).toBe(cents(line.eti.monthlyEti));
}

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
});
