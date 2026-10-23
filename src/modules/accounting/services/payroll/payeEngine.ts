import { getTaxYearConfig, computeAnnualTax } from './taxTables';
import type { PayeInput, PayeResult } from './payrollTypes';

export function getAge(dateOfBirth: Date, atDate: Date): number {
  const years = atDate.getFullYear() - dateOfBirth.getFullYear();
  const m = atDate.getMonth() - dateOfBirth.getMonth();
  return m < 0 || (m === 0 && atDate.getDate() < dateOfBirth.getDate())
    ? years - 1
    : years;
}

function computeRebates(age: number, config: ReturnType<typeof getTaxYearConfig>): number {
  let rebates = config.primaryRebate;
  if (age >= 65) rebates += config.secondaryRebate;
  if (age >= 75) rebates += config.tertiaryRebate;
  return rebates;
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
 * Tax for the year on `input.annualTaxableIncome`, after the age rebates and
 * the medical scheme fees tax credits, never below zero. Shared by the
 * periodic calculation (calculatePAYE) and the annual-payment method
 * (payeAnnualPayment.ts), which takes the difference of two of these.
 * `medicalCredits` is the full annual credit; `medicalCreditUsed` the part of
 * it this tax took off (the credit is not refundable: at most the tax after
 * rebates), which is what the e@syFile 4116 records (payeCumulative).
 */
export function annualTaxAfterCredits(input: PayeInput): {
  annualTax: number; rebates: number; medicalCredits: number; medicalCreditUsed: number;
} {
  const config = getTaxYearConfig(input.taxYear);
  const rebates = computeRebates(input.ageAtPeriodEnd, config);
  const medicalCredits = computeAnnualMedicalCredits(input.monthlyMedicalBeneficiaries, config);
  const grossAnnualTax = computeAnnualTax(input.annualTaxableIncome, config.brackets);
  const taxAfterRebates = Math.max(0, grossAnnualTax - rebates);
  const annualTax = Math.max(0, taxAfterRebates - medicalCredits);
  return { annualTax, rebates, medicalCredits, medicalCreditUsed: taxAfterRebates - annualTax };
}

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
