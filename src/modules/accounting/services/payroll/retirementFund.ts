/**
 * Employee retirement fund contributions in PAYE (PAYE 4c, Hein 2026-10-26).
 *
 * The employer deducts the employee's contributions to a pension, provident or
 * retirement annuity fund from remuneration before working out the employees'
 * tax on it, "limited to the deduction to which employee is entitled under
 * section 11F": the lesser of the year's cap (R430 000 for 2027, R350 000
 * before; TaxYearConfig.retirementDeductionCap) and 27.5% of the higher of
 * remuneration as the Fourth Schedule defines it or taxable income before the
 * s11F deduction, both excluding retirement and severance lump sums (Fourth
 * Schedule paragraph 2(4)(a), (b), (bA); SARS PAYE-GEN-01-G21 (2027) Rev 1
 * p. 10-11 "Retirement fund contributions", and p. 5). The cap is also limited
 * "at any time during the year" to the same fraction of itself as the period
 * remuneration was paid for bears to the year (p. 10): payeCumulative takes
 * the allowed deduction on annualised figures and weights it n ÷ 12, which is
 * that proviso.
 *
 * "The higher of remuneration or taxable income": an employer knows only the
 * remuneration it pays, so taxable income before the deduction is that same
 * remuneration and the base is the employee's taxable remuneration from this
 * employer (periodic pay plus annual payments, before the deduction; lump sums
 * are never in it). Limb (c), taxable income itself, never binds below 100%.
 *
 * Contributions are the deductions coded 4001 (pension), 4003 (provident) and
 * 4006 (retirement annuity), whatever their taxable flag: the code decides
 * (SARS BRS PAYE Employer Reconciliation V25.3.0 p. 101-102: 4001, 4003 and
 * 4006 are the "total ... contributions paid and 'deemed paid' by employee";
 * G21 2027 p. 11 reflects them under those codes).
 *
 * NOT SUPPORTED (PAYE 4b): an employer's contributions to a fund are a taxable
 * fringe benefit (3817 pension, 3825 provident, 3828 retirement annuity) and a
 * contribution "deemed paid" by the employee, deductible within the same cap,
 * reported beside 4472 / 4473 / 4475 (BRS V25.3.0 p. 54, 103; G21 2027 p. 10).
 * IsaFlow computes neither the benefit nor the deemed contribution, so the
 * calculator warns on an employer-contribution component and on an earning
 * coded as one of those benefits (payrollCalculator).
 */

import { normaliseSarsCode } from './payeAnnualPayment';
import { getTaxYearConfig } from './taxTables';
import type { ValidationResult } from './payrollTypes';

/** Section 11F(2)(b): 27.5% of the higher of remuneration and taxable income. */
export const RETIREMENT_DEDUCTION_RATE = 0.275;

const CONTRIBUTION_CODES = new Set(['4001', '4003', '4006']);
/** The fringe benefits of an employer's fund contributions (BRS V25.3.0 p. 54: 4472 → 3817, 4473 → 3825, 4475 → 3828). */
const EMPLOYER_FUND_BENEFIT_CODES = new Set(['3817', '3825', '3828']);

/** A deduction under this code is an employee retirement fund contribution (4001, 4003, 4006). */
export function isRetirementContributionCode(code: string): boolean {
  return CONTRIBUTION_CODES.has(normaliseSarsCode(code));
}

/** An earning under this code is the taxable benefit of an employer's fund contribution (3817, 3825, 3828; PAYE 4b). */
export function isEmployerFundBenefitCode(code: string): boolean {
  return EMPLOYER_FUND_BENEFIT_CODES.has(normaliseSarsCode(code));
}

/**
 * The deduction section 11F allows for a year: the lesser of the year's
 * contributions, 27.5% of the year's remuneration (before the deduction) and
 * the cap. Annual figures in, annual figure out.
 */
export function allowedRetirementDeduction(annualContributions: number, annualRemuneration: number, taxYear: number): number {
  const cap = getTaxYearConfig(taxYear).retirementDeductionCap;
  return Math.max(0, Math.min(annualContributions, RETIREMENT_DEDUCTION_RATE * Math.max(0, annualRemuneration), cap));
}

/** An employer-contribution component: not paid, not taxed, not deducted (PAYE 4b). Error level, so the run page shows it. */
export function employerContributionWarning(name: string, amount: number): ValidationResult {
  return {
    code: 'EMPLOYER_CONTRIBUTION_NOT_SUPPORTED',
    severity: 'error',
    message: `${name} (R ${amount.toFixed(2)}) is an employer contribution, which IsaFlow does not process: it was left out of this line. `
      + 'An employer\'s contribution to a fund or medical scheme is a taxable fringe benefit and, for a retirement fund, a contribution '
      + 'deemed paid by the employee, so PAYE and the IRP5 are wrong while it is assigned. End the assignment, or file the benefit by hand.',
  };
}

/** An earning coded as the benefit of an employer fund contribution: taxed, but its deemed contribution is not deducted (PAYE 4b). */
export function employerFundBenefitWarning(name: string, code: string, amount: number): ValidationResult {
  return {
    code: 'EMPLOYER_FUND_BENEFIT_NOT_DEEMED',
    severity: 'warning',
    message: `${name} (code ${normaliseSarsCode(code)}, R ${amount.toFixed(2)}) is the taxable benefit of an employer's retirement fund contribution. `
      + 'It is taxed, but IsaFlow does not deduct it as a contribution deemed paid by the employee (s11F), nor report it under '
      + '4001/4003/4006 and 4472/4473/4475, so PAYE is over-deducted and the IRP5 lacks the contribution. Correct the certificate by hand.',
  };
}
