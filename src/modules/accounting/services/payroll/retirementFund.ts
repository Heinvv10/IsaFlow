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
 * Employer contributions (wave 5 RF, employerContributions.ts): an employer's
 * contribution to a fund is a taxable fringe benefit (3817 pension, 3825
 * provident, 3828 retirement annuity), assigned as a non-cash earning under that
 * code, and a contribution "deemed paid" by the employee, deducted within the
 * same cap together with the employee's own (G21 2027 p. 10), reported beside
 * 4472 / 4473 / 4475 (BRS V25.3.0 p. 55, 103). A component of type
 * employer_contribution is still not processed (the calculator warns): the
 * benefit code is the way in.
 */

import { normaliseSarsCode } from './payeAnnualPayment';
import { getTaxYearConfig } from './taxTables';
import { EMPLOYER_FUND_BENEFIT_CODES, RETIREMENT_CONTRIBUTION_CODES } from './retirementFundCodes';
import { formatMoney } from '@/lib/money/formatMoney';
import type { ValidationResult } from './payrollTypes';

/** Section 11F(2)(b): 27.5% of the higher of remuneration and taxable income. */
export const RETIREMENT_DEDUCTION_RATE = 0.275;

const CONTRIBUTION_CODES = new Set<string>(RETIREMENT_CONTRIBUTION_CODES);
/** The fringe benefits of an employer's fund contributions (BRS V25.3.0 p. 54: 4472 → 3817, 4473 → 3825, 4475 → 3828). */
const FUND_BENEFIT_CODES = new Set<string>(EMPLOYER_FUND_BENEFIT_CODES);

/** A deduction under this code is an employee retirement fund contribution (4001, 4003, 4006). */
export function isRetirementContributionCode(code: string): boolean {
  return CONTRIBUTION_CODES.has(normaliseSarsCode(code));
}

/** An earning under this code is the taxable benefit of an employer's fund contribution (3817, 3825, 3828; PAYE 4b). */
export function isEmployerFundBenefitCode(code: string): boolean {
  return FUND_BENEFIT_CODES.has(normaliseSarsCode(code));
}

/**
 * The deduction section 11F allows for a year: the lesser of the year's
 * contributions, 27.5% of the year's remuneration (before the deduction) and
 * the cap. Annual figures in, annual figure out.
 */
export function allowedRetirementDeduction(annualContributions: number, annualRemuneration: number, taxYear: number): number {
  return retirementDeductionLimits(annualContributions, annualRemuneration, taxYear).allowed;
}

/** allowedRetirementDeduction with its three limits, for the explanation (payrollExplain), which never recomputes them. */
export function retirementDeductionLimits(annualContributions: number, annualRemuneration: number, taxYear: number): {
  contributions: number; shareOfRemuneration: number; cap: number; allowed: number;
} {
  const cap = getTaxYearConfig(taxYear).retirementDeductionCap;
  const shareOfRemuneration = RETIREMENT_DEDUCTION_RATE * Math.max(0, annualRemuneration);
  return { contributions: annualContributions, shareOfRemuneration, cap, allowed: Math.max(0, Math.min(annualContributions, shareOfRemuneration, cap)) };
}

/** An employer-contribution component: not paid, not taxed, not deducted (PAYE 4b). Error level, so the run page shows it. */
export function employerContributionWarning(name: string, amount: number): ValidationResult {
  return {
    code: 'EMPLOYER_CONTRIBUTION_NOT_SUPPORTED',
    severity: 'error',
    message: `${name} (${formatMoney(amount)}) is an employer contribution, which IsaFlow does not process: it was left out of this line. `
      + 'An employer\'s contribution to a fund or medical scheme is a taxable fringe benefit and, for a retirement fund, a contribution '
      + 'deemed paid by the employee, so PAYE and the IRP5 are wrong while it is assigned. End the assignment, or file the benefit by hand.',
  };
}

/**
 * An employer fund benefit (3817 / 3825 / 3828) that reached the calculator as CASH: a run marks every one non-cash
 * (employerContributions.ts), so this is a line not assembled by a run. Taxed, but not deemed into s11F (RF).
 */
export function employerFundBenefitWarning(name: string, code: string, amount: number): ValidationResult {
  return {
    code: 'EMPLOYER_FUND_BENEFIT_NOT_DEEMED',
    severity: 'warning',
    message: `${name} (code ${normaliseSarsCode(code)}, ${formatMoney(amount)}) is the taxable benefit of an employer's retirement fund contribution, `
      + 'but it was costed as cash pay: it is taxed, and not deducted as a contribution deemed paid by the employee (s11F). Recalculate the pay run.',
  };
}

/** A pre-RF 3817 / 3825 / 3828 assignment kept as cash (migration 975's opt-out): taxed, not deemed; how to switch. */
export function employerFundKeptAsCashWarning(name: string, code: string, amount: number): ValidationResult {
  return {
    code: 'EMPLOYER_FUND_KEPT_AS_CASH',
    severity: 'warning',
    message: `${name} (code ${normaliseSarsCode(code)}, ${formatMoney(amount)}) was assigned before employer retirement contributions were supported, so it is still paid `
      + 'as cash and taxed, and not deducted as a contribution deemed paid by the employee (s11F). If the employer pays this to the fund, end this assignment '
      + 'and assign the component again from the next month: the new assignment is a non-cash benefit deemed paid by the employee (PAYE-GEN-01-G21 (2027) p. 10).',
  };
}

/** A 3817 / 3825 / 3828 component not flagged taxable: no benefit is taxed and nothing is deemed (RF). Error: the approval gate refuses it. */
export function retirementBenefitNotTaxableWarning(name: string, code: string, amount: number): ValidationResult {
  return {
    code: 'RETIREMENT_BENEFIT_NOT_TAXABLE',
    severity: 'error',
    message: `${name} (code ${normaliseSarsCode(code)}, ${formatMoney(amount)}) is an employer's retirement fund contribution, a taxable fringe benefit `
      + '(PAYE-GEN-01-G21 (2027) p. 10), but the component is not taxable: it was not taxed nor deemed paid by the employee. Mark the component taxable and recalculate.',
  };
}

/**
 * Why `paid_outside_payroll` cannot go on this component, or null when it can: only a deduction coded 4001,
 * 4003 or 4006 (the CHECK on payroll_components, migration 948, holds the same rule). Medical aid the employee
 * pays privately (4005; BRS V25.3.0 p. 102 counts it in 4005 when the employer takes it into account) has the
 * same shape and is out of scope (PAYE 4c).
 */
export function paidOutsidePayrollRefusal(componentType: string, code: string): string | null {
  if (componentType === 'deduction' && isRetirementContributionCode(code)) return null;
  return 'Only a retirement fund contribution (a deduction coded 4001 pension, 4003 provident or 4006 retirement annuity) '
    + 'can be paid outside payroll: it then counts for PAYE and the IRP5 but is not deducted from pay. '
    + 'Privately paid medical aid is not supported yet.';
}
