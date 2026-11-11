/**
 * Employer contributions that are a taxable benefit to the employee. Pure.
 *
 * Medical scheme (SARS 3810). A contribution the employer makes to a medical scheme on behalf of the employee is a
 * taxable fringe benefit in the employee's hands (Seventh Schedule para 12A), deemed to be paid by the employee:
 * "the same value included as a taxable benefit (code 3810) should be added to value of the contributions made by
 * the employee (code 4005)" for the medical scheme fees tax credit (s6A) and the age-65 additional credit (s6B).
 * PAYE-GEN-01-G21 (2027 tax year) Rev 1 p. 11-12 (PDF pages 11-12), "Medical scheme fees tax credit",
 * IRP5/IT3(a) details. On the certificate: 3810 is the benefit, 4474 "Employer's medical scheme fees (contributions) paid for the benefit of
 * employees" (BRS V25.3.0 p. 103) equals it, and 4005 "paid and 'deemed paid' by employee" (p. 101) is what the employee paid
 * plus the 3810 amount (the line's stored medical_scheme_fees).
 *
 * A 3810 earning is non-cash: taxed (100%, para 12A has no 80 / 20 rule) but not paid, so it is not in gross pay
 * and net pay. NAMED LIMIT: the Seventh Schedule text itself was not fetched; the G21 wording is the source. The
 * certificate side (3810, 4474, 4005) is easyFileExportService and payrollMedicalRecord.
 *
 * Retirement funds (wave 5 RF). An employer's contribution to a pension, provident or retirement annuity fund for the
 * employee is, from 1 March 2016, "a taxable fringe benefit and a deemed contribution in the hands of the employee.
 * Therefore, current contributions = contributions actually made by the employee plus employer contributions"
 * (PAYE-GEN-01-G21 (2027) Rev 1 p. 10, "Retirement fund contributions"; Seventh Schedule para 12D, not fetched: the
 * G21 wording is the source). It is assigned as an earning under the benefit's code: 3817 pension, 3825 provident,
 * 3828 retirement annuity (BRS V25.3.0 p. 94-95). The run marks it non-cash (the employer pays the fund, not the
 * employee), it is taxed in full, and the same value is deemed paid by the employee into s11F beside the employee's own
 * 4001 / 4003 / 4006, so the cap binds on the total (deemedRetirementContributions; payeCumulative). On the certificate
 * 4472 / 4473 / 4475 equal the benefit and 4001 / 4003 / 4006 include it (BRS p. 55, 101-103; easyFileRetirementFields).
 * UIF and SDL on it follow the component's flags: SDL is on Fourth Schedule remuneration (G21 p. 11), which takes in a
 * fringe benefit; whether UIF does is UNVERIFIED (no UIF source fetched). A defined-benefit fund's benefit is a para
 * 12D(3) fund-member-category value, not the contribution: refused when the component is created (payrollComponentService).
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import { isEmployerFundBenefitCode } from './retirementFund';
import type { EmployeeComponent } from './payrollTypes';

export const EMPLOYER_MEDICAL_FRINGE_CODE = '3810';

export function isEmployerMedicalFringeCode(code: string | null | undefined): boolean {
  return normaliseSarsCode(code) === EMPLOYER_MEDICAL_FRINGE_CODE;
}

const is3810Earning = (c: EmployeeComponent): boolean =>
  c.component.componentType === 'earning' && isEmployerMedicalFringeCode(c.component.sarsSourceCode);

/**
 * A 3810 earning is the employer's share of a medical scheme contribution: never paid in cash, so flagged non-cash as the
 * loan benefit is, and deemed paid by the employee. The employee's own share is a 4005 deduction beside it; the two cannot be
 * told apart from the amounts. Some companies instead pay the 3810 in cash and deduct the whole premium as 4005 (the
 * gross-up): only the explicit `medical_gross_up` record (fringeBenefits.ts) says so, and then the 3810 stays the cash it
 * is and its fees are the 4005 deduction's alone (`medicalGrossUp`). Input is not mutated.
 */
export function markNonCashEmployerBenefits(components: readonly EmployeeComponent[], grossUp = false): EmployeeComponent[] {
  return components.map((c) => {
    // An employer's fund contribution (3817 / 3825 / 3828) is paid to the fund: always non-cash (RF).
    if (isFundBenefitEarning(c)) return { ...c, isNonCash: true };
    if (!is3810Earning(c)) return c;
    return grossUp ? { ...c, medicalGrossUp: true } : { ...c, isNonCash: true };
  });
}

/**
 * The value deemed paid by the employee for the medical credits (G21 p. 12): the taxable 3810 earnings. A 3810 that is
 * not taxable is no taxable benefit, so nothing is deemed (and the line is refused, MEDICAL_BENEFIT_NOT_TAXABLE); under
 * the gross-up opt-in the 4005 deduction already carries the fees.
 */
export function deemedMedicalFees(components: readonly EmployeeComponent[]): number {
  return Math.round(components.filter((c) => is3810Earning(c) && c.component.isTaxable && c.medicalGrossUp !== true).reduce((s, c) => s + c.amount, 0) * 100) / 100;
}

const isFundBenefitEarning = (c: EmployeeComponent): boolean =>
  c.component.componentType === 'earning' && isEmployerFundBenefitCode(c.component.sarsSourceCode);

/**
 * The employer's fund contributions deemed paid by the employee into s11F (G21 (2027) p. 10): the taxable, NON-CASH
 * 3817 / 3825 / 3828 earnings, as a run marks them. A non-taxable one is no taxable benefit, so nothing is deemed (the
 * line is refused, RETIREMENT_BENEFIT_NOT_TAXABLE); one reaching the calculator as cash was not assembled by a run and
 * is taxed but not deemed (EMPLOYER_FUND_BENEFIT_NOT_DEEMED), as the certificate reads only non-cash items.
 */
export function deemedRetirementContributions(components: readonly EmployeeComponent[]): number {
  return Math.round(components.filter((c) => isFundBenefitEarning(c) && c.component.isTaxable && c.isNonCash === true)
    .reduce((s, c) => s + c.amount, 0) * 100) / 100;
}
