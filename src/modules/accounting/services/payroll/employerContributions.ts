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
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import type { EmployeeComponent } from './payrollTypes';

export const EMPLOYER_MEDICAL_FRINGE_CODE = '3810';

export function isEmployerMedicalFringeCode(code: string | null | undefined): boolean {
  return normaliseSarsCode(code) === EMPLOYER_MEDICAL_FRINGE_CODE;
}

const is3810Earning = (c: EmployeeComponent): boolean =>
  c.component.componentType === 'earning' && isEmployerMedicalFringeCode(c.component.sarsSourceCode);

/**
 * The gross-up pattern some companies use: a 3810 earning beside a 4005 deduction of the premium. The earning is cash
 * paid to the employee and the deduction takes the premium back, so the fees are already counted once (the 4005) and
 * the 3810 must neither become non-cash nor count a second time. Kept as configured, with a warning.
 */
export function hasGrossUpPattern(components: readonly EmployeeComponent[]): boolean {
  return components.some(is3810Earning) && components.some((c) =>
    c.component.componentType === 'deduction' && normaliseSarsCode(c.component.sarsSourceCode) === '4005' && c.amount > 0);
}

/** A 3810 earning is never paid in cash: flag it, as the loan benefit is (not in the gross-up pattern). Input is not mutated. */
export function markNonCashEmployerBenefits(components: readonly EmployeeComponent[]): EmployeeComponent[] {
  if (hasGrossUpPattern(components)) return [...components];
  return components.map((c) => (is3810Earning(c) ? { ...c, isNonCash: true } : c));
}

/**
 * The value deemed paid by the employee for the medical credits (G21 p. 12): the taxable 3810 earnings. A 3810 that is
 * not taxable is no taxable benefit, so nothing is deemed (and the line is refused, MEDICAL_BENEFIT_NOT_TAXABLE); in
 * the gross-up pattern the 4005 deduction already carries the fees.
 */
export function deemedMedicalFees(components: readonly EmployeeComponent[]): number {
  if (hasGrossUpPattern(components)) return 0;
  return Math.round(components.filter((c) => is3810Earning(c) && c.component.isTaxable).reduce((s, c) => s + c.amount, 0) * 100) / 100;
}
