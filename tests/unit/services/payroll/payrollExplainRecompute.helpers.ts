/**
 * The independent recompute of a line's explanation (EX-core): it reads only the steps (by key) and applies the
 * statutory arithmetic they state. Shared by payrollExplainRecompute.test.ts and payrollExplainFooting.test.ts.
 */
import { expect } from 'vitest';
import type { PayrollLineResult } from '@/modules/accounting/services/payroll/payrollTypes';
import type { ExplainStep, FigureExplanation } from '@/modules/accounting/services/payroll/payrollExplainTypes';

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const cents = (n: number) => Math.round(n * 100);

export function stepsByKey(fig: FigureExplanation): Map<string, ExplainStep> {
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
  if (r.has('paye.regularDirective.regular')) {
    // DR: a fixed percentage of the base and of the annual payments, or the fixed amount when regular pay was paid; capped at the cash.
    if (r.has('paye.regularDirective.rate')) {
      regular = round2(r.amt('paye.regularDirective.rate') * r.amt('paye.regularDirective.base'));
      annual = round2(r.amt('paye.regularDirective.rate') * r.amt('paye.regularDirective.annualBase'));
    } else {
      regular = r.amt('paye.regularDirective.base') > 0 ? r.amt('paye.regularDirective.fixed') : 0;
      annual = r.amt('paye.regularDirective.annual');
    }
    expect(cents(r.amt('paye.regularDirective.regular'))).toBe(cents(regular));
    expect(cents(r.amt('paye.regularDirective.annual'))).toBe(cents(annual));
    if (r.has('paye.regularDirective.cap')) {
      const room = r.amt('paye.regularDirective.cap');
      const kept = Math.min(regular, room);
      annual = round2(Math.min(annual, room - kept));
      regular = round2(kept);
    }
  } else if (r.has('paye.flat')) {
    regular = round2(r.amt('paye.flatRate') * Math.max(0, r.amt('paye.balance')));
  } else if (r.has('paye.annualEquivalent')) {
    const n = r.amt('paye.periods');
    const toDate = r.amt('paye.ytdPeriodicTaxable') + r.amt('paye.regularTaxable');
    const ae = n > 0 ? (toDate * 12) / n : 0;
    expect(r.amt('paye.periodicToDate')).toBeCloseTo(toDate, 6);
    expect(r.amt('paye.annualEquivalent')).toBeCloseTo(ae, 6);
    let off = 0;
    if (r.has('paye.retirement')) {
      const share = r.amt('paye.retirement.rate') * Math.max(0, r.amt('paye.retirement.base'));
      expect(r.amt('paye.retirement.rateLimit')).toBeCloseTo(share, 6);
      const allowed = Math.max(0, Math.min(r.amt('paye.retirement.annualised'), share, r.amt('paye.retirement.cap')));
      expect(r.amt('paye.retirement.allowed')).toBeCloseTo(allowed, 6);
      off = r.amt('paye.retirement');
      expect(off).toBeCloseTo(Math.min(allowed, r.amt('paye.retirement.ceiling')), 6);
    }
    const taxedAE = Math.max(0, ae - off);
    expect(r.amt('paye.taxedAnnualEquivalent')).toBeCloseTo(taxedAE, 6);
    expect(r.amt('paye.atAE.income')).toBeCloseTo(taxedAE, 6);
    const taxAE = taxFromBlock(r, 'paye.atAE');
    let taxAll = taxAE;
    let taxEarlier = taxAE;
    if (r.has('paye.offAnnual')) {
      const capToDate = (r.amt('paye.retirement.cap') * r.amt('paye.offAnnual.capPeriods')) / 12;
      expect(r.amt('paye.offAnnual.capToDate')).toBeCloseTo(capToDate, 6);
      expect(r.amt('paye.offAnnual.capLeft')).toBeCloseTo(capToDate - r.amt('paye.offAnnual.offPeriodicToDate'), 6);
      const limits = ['deductionLeft', 'annualPayments', 'contributionsLeft', 'capLeft'].map(k => r.amt(`paye.offAnnual.${k}`));
      expect(-r.amt('paye.offAnnual')).toBeCloseTo(Math.max(0, Math.min(...limits)), 6);
    }
    if (r.has('paye.annualPayments')) {
      expect(r.amt('paye.atAll.income')).toBeCloseTo(taxedAE + r.amt('paye.annualPayments'), 6);
      taxAll = taxFromBlock(r, 'paye.atAll');
      if (r.has('paye.atEarlier')) {
        expect(r.amt('paye.atEarlier.income')).toBeCloseTo(taxedAE + r.amt('paye.annualEarlier'), 6);
        taxEarlier = taxFromBlock(r, 'paye.atEarlier');
      }
    }
    const liability = (taxAE * n) / 12 + (taxAll - taxAE);
    expect(r.amt('paye.liability')).toBeCloseTo(liability, 6);
    const due = Math.max(0, round2(liability - r.amt('paye.ytdTablePaye')));
    expect(cents(r.amt('paye.due'))).toBe(cents(due));
    annual = round2(Math.min(due, Math.max(0, taxAll - taxEarlier)));
    regular = round2(due - annual);
  }
  return round2(regular + annual + directive);
}

function recomputeUif(fig: FigureExplanation): number {
  const r = reader(fig);
  if (r.has('uif.none')) return 0;
  const leviable = Math.min(r.amt('uif.remuneration'), r.amt('uif.ceiling'));
  expect(r.amt('uif.leviable')).toBeCloseTo(leviable, 9);
  const each = round2(leviable * r.amt('uif.rate'));
  expect(cents(r.amt('uif.employer'))).toBe(cents(each));
  return each;
}

export function recomputeSdl(fig: FigureExplanation): number {
  const r = reader(fig);
  if (r.has('sdl.none')) return 0;
  const pay = r.amt('sdl.ytdApplicable') + r.amt('sdl.applicable');
  const deduction = r.amt('sdl.ytdDeduction') + r.amt('sdl.deduction');
  const toDate = Math.min(pay, Math.max(0, pay - deduction));
  const leviable = Math.max(0, round2(toDate - r.amt('sdl.carried')));
  expect([r.amt('sdl.payToDate'), r.amt('sdl.deductionToDate'), r.amt('sdl.leviableToDate'), r.amt('sdl.leviable')].map(cents))
    .toEqual([pay, deduction, toDate, leviable].map(cents));
  const exempt = r.amt('sdl.annualRemuneration') <= r.amt('sdl.threshold');
  return exempt ? 0 : round2(leviable * r.amt('sdl.rate'));
}

function recomputeEti(fig: FigureExplanation): number {
  const r = reader(fig);
  if (r.has('eti.ineligible')) return 0;
  // With the hours known, the table reads the remuneration grossed up to 160 hours, and the result is grossed down by
  // the hours share (ETI Act s7(5)); without them, the remuneration as paid and the whole of it.
  const hours = r.has('eti.hours') ? r.amt('eti.hours') : null;
  const paid = r.amt('eti.remuneration');
  const rem = hours !== null && hours < 160 ? (paid * 160) / hours : paid;
  if (hours !== null) expect(r.amt('eti.tabled')).toBeCloseTo(rem, 6);
  const share = hours !== null ? Math.min(1, hours / 160) : 1;
  if (hours !== null) expect(r.amt('eti.share')).toBeCloseTo(share, 9);
  const t = (k: string) => r.amt(`eti.table.${k}`);
  let yearOne: number;
  if (rem >= t('wageCeiling')) yearOne = 0;
  else if (rem < t('lowBandCeiling')) yearOne = t('lowBandRate') * rem;
  else if (rem < t('taperStart')) yearOne = t('maxMonthlyEti');
  else yearOne = t('maxMonthlyEti') - t('taperRate') * (rem - t('taperStart'));
  expect(r.amt('eti.band')).toBeCloseTo(yearOne, 9);
  return round2(Math.max(0, r.amt('eti.employmentYear') === 1 ? yearOne : yearOne / 2) * share);
}

/**
 * Every total foots: its amount is the sum of its parts to half a cent (a total the engine rounds to the cent), and a
 * "Not below nil" part appears only where the parts went below nil and the engine floored the total at nil.
 */
export function footingProblems(fig: FigureExplanation): string[] {
  const out: string[] = [];
  for (const s of stepsByKey(fig).values()) {
    if (!s.total) continue;
    const kids = s.children ?? [];
    const sum = kids.reduce((t, c) => t + (c.amount ?? 0), 0);
    if (Math.abs(sum - (s.amount ?? 0)) > 0.005 + 1e-9) out.push(`${s.key}: ${s.amount} but its parts add to ${sum}`);
    const floor = kids.find(c => c.key === `${s.key}.floor`);
    if (floor && !((s.amount ?? 0) === 0 && (floor.amount ?? 0) > 0)) out.push(`${s.key}: a floor of ${floor.amount} on ${s.amount}`);
  }
  return out;
}

export function expectRecomputes(line: PayrollLineResult) {
  const e = line.explanations;
  expect([e.paye, e.uif, e.sdl, e.eti].flatMap(footingProblems)).toEqual([]);
  expect({ paye: cents(recomputePaye(e.paye)), uif: cents(recomputeUif(e.uif)), sdl: cents(recomputeSdl(e.sdl)), eti: cents(recomputeEti(e.eti)) })
    .toEqual({ paye: cents(line.paye.monthlyPaye), uif: cents(line.uif.employeeContribution), sdl: cents(line.sdl), eti: cents(line.eti.monthlyEti) });
  expect(cents(e.paye.result)).toBe(cents(line.paye.monthlyPaye));
  expect(cents(e.uif.result)).toBe(cents(line.uif.employeeContribution));
  expect(cents(e.sdl.result)).toBe(cents(line.sdl));
  expect(cents(e.eti.result)).toBe(cents(line.eti.monthlyEti));
}

