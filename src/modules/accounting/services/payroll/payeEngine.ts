import { getTaxYearConfig, bracketFor, computeAnnualTax, type TaxBracket } from './taxTables';
import type { PayeInput, PayeResult } from './payrollTypes';

export function getAge(dateOfBirth: Date, atDate: Date): number {
  const years = atDate.getFullYear() - dateOfBirth.getFullYear();
  const m = atDate.getMonth() - dateOfBirth.getMonth();
  return m < 0 || (m === 0 && atDate.getDate() < dateOfBirth.getDate())
    ? years - 1
    : years;
}

/** The age rebates (s6(2)): primary for everyone, secondary from 65, tertiary from 75; each part as granted. */
export interface RebateParts { primary: number; secondary: number; tertiary: number }

function computeRebates(age: number, config: ReturnType<typeof getTaxYearConfig>): RebateParts {
  return {
    primary: config.primaryRebate,
    secondary: age >= 65 ? config.secondaryRebate : 0,
    tertiary: age >= 75 ? config.tertiaryRebate : 0,
  };
}

function computeAnnualMedicalCredits(
  monthlyBeneficiaries: number,
  config: ReturnType<typeof getTaxYearConfig>,
): number {
  if (monthlyBeneficiaries <= 0) return 0;
  const mainAndFirst = Math.min(monthlyBeneficiaries, 2) * config.medicalCreditMainAndFirst;
  const additional = Math.max(0, monthlyBeneficiaries - 2) * config.medicalCreditAdditional;
  return (mainAndFirst + additional) * 12;
}

/**
 * The part of the additional medical expenses tax credit (section 6B) an
 * employer takes into account for employees' tax, for an employee 65 or older
 * on the last day of the year of assessment: "33,3% of the fees paid to a
 * medical scheme or qualifying foreign fund as exceeds three times the amount
 * of the MTC to which that person is entitled" (section 6B(3)(a)(i);
 * paragraph 9(6) of the Fourth Schedule). SARS Guide on the Determination of
 * Medical Tax Credits, Issue 18, p. 31-32 ("Employees' tax implications"), and
 * p. 21 (3.6.1, the formula 33,3% x {[A - (3 x B)] + C}). The out-of-pocket
 * part (C, section 6B(3)(a)(ii)) "may not be taken into account for employees'
 * tax purposes" (p. 32, note 51), and IsaFlow does not hold it. `fees` are the
 * fees the employee pays through payroll (deductions coded 4005), annual.
 * G21 2027 p. 10 only says the credit "must be taken into account to calculate
 * monthly PAYE"; the guide is where the formula is. Hein 2026-10-23.
 */
/** s6B(3)(a)(i): 33,3% of the fees in excess of three times the MTC. */
export const ADDITIONAL_MEDICAL_RATE = 0.333;
export const ADDITIONAL_MEDICAL_MTC_MULTIPLE = 3;

function computeAdditionalMedicalCredit(age: number, monthlyBeneficiaries: number, annualFees: number, medicalCredits: number): number {
  // No scheme membership on the employee (no MTC): 4005 fees with no member to pay them for are a data
  // error, and "fees as exceeds three times the MTC" would otherwise be a third of all of them.
  if (age < 65 || monthlyBeneficiaries <= 0 || annualFees <= 0) return 0;
  return ADDITIONAL_MEDICAL_RATE * Math.max(0, annualFees - ADDITIONAL_MEDICAL_MTC_MULTIPLE * medicalCredits);
}

/**
 * Tax for the year on `input.annualTaxableIncome`, after the age rebates, the
 * medical scheme fees tax credit (section 6A) and, for 65 and older, the
 * additional medical expenses tax credit (computeAdditionalMedicalCredit),
 * never below zero; each credit is non-refundable and taken in that order.
 * Shared by the periodic calculation (calculatePAYE) and the annual-payment
 * method (payeAnnualPayment.ts), which takes the difference of two of these.
 * `medicalCredits` / `additionalMedicalCredits` are the full annual credits;
 * the `...Used` figures the part of each this tax took off, which is what the
 * e@syFile 4116 / 4120 record (payeCumulative).
 */
export interface AnnualTaxAfterCredits {
  annualTax: number; rebates: number; medicalCredits: number; medicalCreditUsed: number;
  additionalMedicalCredits: number; additionalMedicalCreditUsed: number;
  /** The steps, exposed for the explanation (payrollExplain), which never recomputes them. */
  annualTaxableIncome: number; bracket: TaxBracket; grossAnnualTax: number; rebateParts: RebateParts;
  annualMedicalSchemeFees: number; monthlyMedicalBeneficiaries: number; ageAtPeriodEnd: number;
}

export function annualTaxAfterCredits(input: PayeInput): AnnualTaxAfterCredits {
  const config = getTaxYearConfig(input.taxYear);
  const rebateParts = computeRebates(input.ageAtPeriodEnd, config);
  const rebates = rebateParts.primary + rebateParts.secondary + rebateParts.tertiary;
  const medicalCredits = computeAnnualMedicalCredits(input.monthlyMedicalBeneficiaries, config);
  const annualMedicalSchemeFees = input.annualMedicalSchemeFees ?? 0;
  const additionalMedicalCredits = computeAdditionalMedicalCredit(
    input.ageAtPeriodEnd, input.monthlyMedicalBeneficiaries, annualMedicalSchemeFees, medicalCredits);
  const bracket = bracketFor(input.annualTaxableIncome, config.brackets);
  const grossAnnualTax = computeAnnualTax(input.annualTaxableIncome, config.brackets);
  const taxAfterRebates = Math.max(0, grossAnnualTax - rebates);
  const taxAfterMedicalCredit = Math.max(0, taxAfterRebates - medicalCredits);
  const annualTax = Math.max(0, taxAfterMedicalCredit - additionalMedicalCredits);
  return {
    annualTax, rebates, medicalCredits, medicalCreditUsed: taxAfterRebates - taxAfterMedicalCredit,
    additionalMedicalCredits, additionalMedicalCreditUsed: taxAfterMedicalCredit - annualTax,
    annualTaxableIncome: input.annualTaxableIncome, bracket, grossAnnualTax, rebateParts,
    annualMedicalSchemeFees, monthlyMedicalBeneficiaries: input.monthlyMedicalBeneficiaries, ageAtPeriodEnd: input.ageAtPeriodEnd,
  };
}

/**
 * `medicalCreditsApplied` is the medical scheme fees tax credit (section 6A)
 * only, as before R3; the 65+ additional credit is in `annualTax` but not in
 * that field (adding a field would change every stored PayeResult shape). The
 * additional credit a line took is PayrollLineResult.additionalMedicalCredit.
 */
export function calculatePAYE(input: PayeInput): PayeResult {
  const { annualTax, rebates, medicalCredits: annualMedicalCredits } = annualTaxAfterCredits(input);
  const monthlyPaye = Math.round((annualTax / 12) * 100) / 100;

  const effectiveRate =
    input.annualTaxableIncome > 0 ? annualTax / input.annualTaxableIncome : 0;

  return {
    annualTax: Math.round(annualTax * 100) / 100,
    monthlyPaye,
    effectiveRate: Math.round(effectiveRate * 10_000) / 10_000,
    rebatesApplied: Math.round(rebates * 100) / 100,
    medicalCreditsApplied: Math.round(annualMedicalCredits * 100) / 100,
  };
}
