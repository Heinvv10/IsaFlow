/**
 * The employee's retirement fund contributions on an e@syFile employee record
 * (PAYE 4c). SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26): 4001
 * pension and 4003 provident (p. 101), 4006 retirement annuity (p. 102), each
 * the "total ... contributions paid and 'deemed paid' by employee"; N15, cents
 * omitted, no negatives, and a code with no value is not reported (p. 53-54).
 * The whole contributions, not the deduction the PAYE allowed (SARS
 * PAYE-GEN-01-G21 (2027) p. 11). The 'deemed paid' part (wave 5 RF) is the
 * employer's contribution, a non-cash 3817 / 3825 / 3828 benefit (p. 101-102:
 * "'Deemed paid' by employee is the value of the taxable benefit (code 3817)",
 * 3825, 3828), so 4001 / 4003 / 4006 include it (withDeemedEmployerContributions),
 * and the employer's contribution itself is 4472 pension, 4473 provident, 4475
 * retirement annuity (p. 103), equal to the benefit; p. 55: "If code 4472 is
 * completed, then code 3817 ... and code 4001 must be completed", the same for
 * 4473 (3825, 4003) and 4475 (3828, 4006). The benefit codes themselves are the
 * certificate's non-cash income (payrollNonCashFiling).
 * 4030 (p. 102): donations deducted from remuneration and paid over by the employer, reported in full, "not only the
 * allowable portion" (G21 (2027) p. 11). 4497 (p. 57): the total of every 40xx / 44xx / 45xx value on the record,
 * mandatory when any is completed and absent when none is; after the deduction codes, before 4101 / 4102.
 */

import { formatField } from './easyFileFields';

/** The year's contributions by code (deductions coded 4001 / 4003 / 4006; payrollRetirementRecord). */
export interface RetirementContributions {
  pension4001: number;
  provident4003: number;
  annuity4006: number;
  /** Donations (4030) deducted in the year, whatever PAYE allowed of them; a net negative reports nothing. */
  donations4030: number;
}

const field = (code: number, amount: number): string | null => (Math.floor(amount) > 0 ? formatField(code, amount, 'N') : null);

/** A certificate's non-cash income by code (payrollNonCashFiling.NonCashBenefitFiling). */
export interface CertifiedBenefit { sourceCode: string; amount: number }

/** Benefit code → [the employee's contribution code it is deemed into, the employer's contribution code] (BRS p. 55, 101-103). */
const EMPLOYER_FUND_CODES: ReadonlyArray<[string, keyof Omit<RetirementContributions, 'donations4030'>, number]> = [
  ['3817', 'pension4001', 4472], ['3825', 'provident4003', 4473], ['3828', 'annuity4006', 4475],
];

const benefitTotal = (fringe: readonly CertifiedBenefit[], code: string): number =>
  fringe.filter((f) => f.sourceCode === code).reduce((n, f) => n + f.amount, 0);

/** 4001 / 4003 / 4006 with the employer's contributions deemed paid by the employee added (RF). Unchanged when there are none. */
export function withDeemedEmployerContributions(r: RetirementContributions | undefined, fringe: readonly CertifiedBenefit[]): RetirementContributions | undefined {
  if (EMPLOYER_FUND_CODES.every(([code]) => benefitTotal(fringe, code) <= 0)) return r;
  const out: RetirementContributions = { ...(r ?? { pension4001: 0, provident4003: 0, annuity4006: 0, donations4030: 0 }) };
  for (const [code, key] of EMPLOYER_FUND_CODES) out[key] = Math.round((out[key] + Math.max(0, benefitTotal(fringe, code))) * 100) / 100;
  return out;
}

/** The employer's contribution field each non-cash benefit is reported beside (BRS V25.3.0 p. 103), in code order. */
const EMPLOYER_CONTRIBUTION_FIELDS: ReadonlyArray<[string, number]> = [['3817', 4472], ['3825', 4473], ['3810', 4474], ['3828', 4475]];

/**
 * The employer's own contribution codes in code order, each equal to its benefit; none without a value: 4472 / 4473 / 4475
 * (pension, provident, RA; RF) and 4474, the medical scheme contribution (V13.1 rule "3810 must equal 4474"; FB).
 */
export function employerFundContributionFields(fringe: readonly CertifiedBenefit[]): string[] {
  return EMPLOYER_CONTRIBUTION_FIELDS.map(([code, employer]) => field(employer, benefitTotal(fringe, code))).filter((l): l is string => l !== null);
}


/** 4001 and 4003 (before 4005) and 4006 (after it), so the record stays in code order; none without a value. */
export function retirementFieldLines(r: RetirementContributions | undefined): { beforeMedical: (string | null)[]; afterMedical: (string | null)[] } {
  if (!r) return { beforeMedical: [], afterMedical: [] };
  return {
    beforeMedical: [field(4001, r.pension4001), field(4003, r.provident4003)],
    afterMedical: [field(4006, r.annuity4006), field(4030, r.donations4030)],
  };
}

const DEDUCTION_CODE = /^4[045]\d\d$/;

/**
 * The record with 4497 (the sum of its emitted 40xx / 44xx / 45xx values) in code order; unchanged when none. BRS V25.3.0
 * p. 57: 4497 is the "Total of all values specified under 40-deduction, 44-contribution and 45-information codes", so
 * 4474 (employer's medical contribution) and 4582 (the PAYE portion of 3701 / 3802) are in it.
 */
export function withDeductionTotal(record: string[]): string[] {
  let last = -1;
  let firstAbove = -1;
  let total = 0;
  record.forEach((l, i) => {
    const [code, value] = l.split(',');
    if (code === '4497' || !DEDUCTION_CODE.test(code ?? '')) return;
    total += Number(value);
    // After the last code below 4497; with none, before the first above it (4582, an information code).
    if (Number(code) < 4497) last = i;
    else if (firstAbove < 0) firstAbove = i;
  });
  const at = last >= 0 ? last + 1 : firstAbove;
  return at < 0 ? record : [...record.slice(0, at), `4497,${Math.floor(total)}`, ...record.slice(at)];
}
