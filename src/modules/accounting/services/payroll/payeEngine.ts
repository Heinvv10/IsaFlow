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

export function calculatePAYE(input: PayeInput): PayeResult {
  const config = getTaxYearConfig(input.taxYear);
  const age = input.ageAtPeriodEnd;

  const rebates = computeRebates(age, config);
  const annualMedicalCredits = computeAnnualMedicalCredits(
    input.monthlyMedicalBeneficiaries,
    config,
  );

  const grossAnnualTax = computeAnnualTax(input.annualTaxableIncome, config.brackets);
  const taxAfterRebates = Math.max(0, grossAnnualTax - rebates);
  const annualTax = Math.max(0, taxAfterRebates - annualMedicalCredits);
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
