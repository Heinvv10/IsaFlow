/**
 * Employer contributions that are a taxable benefit to the employee. Pure.
 *
 * Medical scheme (SARS 3810). A contribution the employer makes to a medical scheme on behalf of the employee is a
 * taxable fringe benefit in the employee's hands (Seventh Schedule para 12A), deemed to be paid by the employee:
 * "the same value included as a taxable benefit (code 3810) should be added to value of the contributions made by
 * the employee (code 4005)" for the medical scheme fees tax credit (s6A) and the age-65 additional credit (s6B).
 * PAYE-GEN-01-G21 (2027 tax year) Rev 1 p. 11-12 (PDF pages 11-12), "Medical scheme fees tax credit",
 * IRP5/IT3(a) details. The IRP5 shows 4474 for contributions the employee paid, 3810 for the fringe benefit and 4005
 * for the deemed contributions; BRS V25.3.0 codes 3810 p. 94, 4474 p. 103.
 *
 * A 3810 earning is non-cash: taxed (100%, para 12A has no 80 / 20 rule) but not paid, so it is not in gross pay
 * and net pay. NAMED LIMIT: the Seventh Schedule text itself was not fetched; the G21 wording is the source. Whether
 * the 4005 deemed amount is also reported on the certificate is the IRP5 builder's, not this file's.
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent } from './payrollTypes';

export const EMPLOYER_MEDICAL_FRINGE_CODE = '3810';

export function isEmployerMedicalFringeCode(code: string | null | undefined): boolean {
  return normaliseSarsCode(code) === EMPLOYER_MEDICAL_FRINGE_CODE;
}

const is3810Earning = (c: EmployeeComponent): boolean =>
  c.component.componentType === 'earning' && isEmployerMedicalFringeCode(c.component.sarsSourceCode);

/** A 3810 earning is never paid in cash: flag it, as the loan benefit is. Input is not mutated. */
export function markNonCashEmployerBenefits(components: readonly EmployeeComponent[]): EmployeeComponent[] {
  return components.map((c) => (is3810Earning(c) ? { ...c, isNonCash: true } : c));
}

/** The value deemed paid by the employee for the medical credits: the sum of the 3810 earnings (G21 p. 12). */
export function deemedMedicalFees(components: readonly EmployeeComponent[]): number {
  return Math.round(components.filter(is3810Earning).reduce((s, c) => s + c.amount, 0) * 100) / 100;
}
